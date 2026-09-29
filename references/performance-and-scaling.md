# D1 performance, cost and scaling

Sources: use-indexes, limits, read-replication, retry-queries, release notes (developers.cloudflare.com/d1/), D1 "turning it up to 11" blog.

## Contents
- How throughput works
- Limits table
- Indexes: when, how, verify
- Query patterns that read too many rows
- Multi-column and partial indexes
- Read replication and Sessions API
- Retries
- Scaling out

## How throughput works

- Each database is backed by a single Durable Object and processes queries **one at a time**. Each read replica is its own instance and follows the same rule independently.
- Max throughput is about `1000 / avg_query_ms` queries per second: 1 ms is about 1,000 qps; 100 ms is about 10 qps.
- Concurrent overflow first queues, then returns an "overloaded" error (HTTP API returns 429; the Workers API surfaces an error).
- Indexed point reads (`SELECT name FROM users WHERE id = ?`) are typically under 1 ms of SQL time. Writes take several milliseconds and grow with rows written because they are persisted durably across several locations.
- Query execution and result serialization also consume Worker CPU and memory (Workers limits apply).
- Large data migrations (mass UPDATE/DELETE) must be chunked (about 1,000 rows per statement/batch); one statement touching hundreds of thousands of rows or hundreds of MB will exceed execution limits.
- A Worker invocation can hold at most 6 simultaneous connections to D1.

## Limits (snapshot; verify live before relying on a number)

| Feature | Workers Paid | Workers Free |
|---|---|---|
| Databases per account | 50,000 (raisable) | 10 |
| Max database size | 10 GB (not raisable) | 500 MB |
| Storage per account | 1 TB (raisable) | 5 GB |
| Time Travel window | 30 days | 7 days |
| Time Travel restores | 10 per 10 min per DB | same |
| Queries per Worker invocation | 1,000 | 50 |
| Columns per table | 100 | 100 |
| Rows per table | unlimited (within DB size) | same |
| Max string, BLOB or row size | 2,000,000 bytes | same |
| Max SQL statement length | 100,000 bytes | same |
| Max bound parameters per query | 100 | same |
| Max arguments per SQL function | 32 | same |
| Max `LIKE`/`GLOB` pattern | 50 bytes | same |
| Max SQL query duration | 30 s (also bounds whole batch) | same |
| `d1 execute --file` size | 5 GB (uploaded via R2) | same |

Free plan daily limits (rows read/written) are enforced since 2025-02-10: when exceeded, queries via Workers or REST API return errors until the reset at 00:00 UTC. Paid plan minimum is $5/month. Check current numbers on the pricing and limits pages; this snapshot did not include the pricing page.

Batch note: per-query limits apply to each statement in `batch()`.

Need more? Databases per account, storage per account and other limits can be raised by request via Cloudflare's limit increase form (the 10 GB per-database cap cannot).

## Indexes

### When to add one
- Columns in frequent `WHERE` predicates (email, username, user id, dates).
- Uniqueness (`CREATE UNIQUE INDEX`).
- Columns used together in queries (`(customer_id, transaction_date)`).
- Join columns (`ON orders.customer_id = customers.id`).
- Not needed for `INTEGER PRIMARY KEY` / default rowid.
- Indexes update automatically on write; you never maintain them by hand.

### Create, list, test, remove

```sql
-- naming convention: idx_<table>_<columns>
CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);
PRAGMA optimize;                       -- refresh planner statistics after schema change

SELECT name, type, sql FROM sqlite_schema WHERE type = 'index';   -- list

EXPLAIN QUERY PLAN SELECT * FROM users WHERE email_address = 'foo@example.com';
-- good: SEARCH users USING INDEX idx_email_address (email_address=?)
-- bad:  SCAN users

DROP INDEX idx_orders_customer_id;     -- irreversible; indexes cannot be altered
```

To change an index, drop it and create a new one, through a migration (not at request time).

### Considerations
- Every index costs storage (it is effectively a table) and extra work on writes to indexed columns. It usually pays off; do not index everything.
- Cannot reference other tables or use non-deterministic functions.
- Add indexes for your most-queried patterns; verify with `meta.rows_read`.

## Query patterns that read or write too many rows

D1 bills by rows read and written, so these patterns hurt cost and latency. Most surprisingly large bills come from a few hot queries that read far more rows than they return.

| Pattern | Why it is expensive | Fix |
|---|---|---|
| `WHERE col = ?` on unindexed col | Full scan every call | Index the column |
| `WHERE a = ? AND b = ?`, no index | Full scan. An index on only one column still reads every row matching that column | Multi-column index `(a, b)` |
| `JOIN o ON o.x = m.y` with unindexed `o.x` | Repeated scans or a temporary index | Index the join column, check the plan |
| Correlated subquery filtering unindexed columns | Inner query may run per candidate row | Index columns used by the subquery |
| `ORDER BY RANDOM() LIMIT 1` | Reads and sorts the entire result set | Use another sampling strategy suited to the key type and distribution |
| `LIKE '%term%'` (leading wildcard), even inside `COUNT(*)` | B-tree index cannot help; full scan | Prefix search `LIKE 'term%'`, or FTS5 trigram tokenizer (3+ chars), and verify with EXPLAIN |
| `CREATE INDEX` or other DDL per request | Index build writes every row; writes cost more than reads | Do it once in a migration |
| Deep `OFFSET` pagination (general SQLite behavior) | Skipped rows are still read | Keyset pagination: `WHERE id > ?last ORDER BY id LIMIT n` |

How to find the worst offenders: use the D1 dashboard or log `meta.rows_read`/`meta.rows_written`; focus on read-heavy queries with a large `rows_read / rows returned` and high call frequency. One query running thousands of times a day matters far more than a rare complex one.

## Multi-column indexes (leftmost-prefix rule)

For `CREATE INDEX idx ON transactions(customer_id, transaction_date)`:

| Query filters on | Uses index? |
|---|---|
| `customer_id` and `transaction_date` | Yes |
| `customer_id` only | Yes (leftmost column) |
| `transaction_date` only | No (leftmost column missing) |

With three columns `(a, b, c)`: `a`; `a,b`; `a,b,c` use it; `b,c` does not. Put the equality-filtered, most-selective, always-present column first.

## Partial indexes

Index only the rows you query:

```sql
CREATE INDEX idx_order_status_not_complete ON orders(order_status) WHERE order_status != 6;
```

Smaller index, faster reads and writes, and it does not grow with every completed row. Combine with multi-column indexes. The `WHERE` clause may only use deterministic functions. A query must be compatible with the index's `WHERE` for the planner to use it.

## Read replication and the Sessions API

What it does: D1 keeps asynchronously replicated read-only copies of the primary in multiple regions (ENAM, WNAM, WEUR, EEUR, APAC, OC; subject to change). Read latency drops for users near a replica and read throughput scales because more instances serve reads. **All writes still go to the primary.** Replicas can lag; the Sessions API hides that by enforcing sequential consistency.

Cost: no extra storage or compute charge; you pay the same `rows_read`/`rows_written` with or without replicas.

### Enable / disable / check

- Dashboard: D1 -> your database -> **Settings** -> **Enable Read Replication**.
- REST (token needs `D1:Edit`; `D1:Read` to check):

```bash
# enable
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/d1/database/$DATABASE_ID" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"read_replication": {"mode": "auto"}}'
# disable: {"read_replication": {"mode": "disabled"}}  (replicas may keep serving for up to 24 hours)
# check: GET the same URL and read result.read_replication.mode ("auto" or "disabled")
```

- Sessions API code is safe to ship before enabling replication and after disabling it.
- Sessions API exists only in the Worker binding, not the REST API.

### Using sessions correctly

```ts
const bookmark = request.headers.get("x-d1-bookmark") ?? "first-unconstrained";
const session = env.DB.withSession(bookmark);
// ... use session.prepare()/batch() for every query in this request
const res = new Response(...);
res.headers.set("x-d1-bookmark", session.getBookmark() ?? "");
```

Choosing the starting constraint:
- `first-unconstrained` (default): best latency; fine when slightly stale data is OK.
- `first-primary`: guarantees the freshest starting point (e.g. right after login or checkout); later queries may use replicas.
- bookmark: continue a logical user session across requests; guarantees at least that version.

Guarantees within a session: monotonic reads, monotonic writes, writes-follow-reads, read-your-own-writes. Mechanism: each query carries a bookmark; a replica waits until it has caught up to that bookmark before serving.

Anti-pattern: using `env.DB.prepare(...)` directly for reads and expecting replica performance. Only session queries can hit replicas.

Observability: `meta.served_by_region` and `meta.served_by_primary` (undefined in local dev) plus dashboard metrics broken down by region.

## Retries

- D1 automatically retries **read-only** queries (only `SELECT`, `EXPLAIN`, `WITH`) up to two additional times on retryable errors; retries are guaranteed not to leave writes behind. See `meta.total_attempts`.
- Retry **writes yourself**, only when idempotent by your business logic (for example `INSERT ... ON CONFLICT DO NOTHING`, or an update keyed by a client-supplied idempotency token).
- Use exponential backoff with jitter and a small attempt cap (docs example: up to 5 attempts).
- Retry only errors documented as transient. The docs example matches messages containing `Network connection lost`, `storage caused object to be reset`, or `reset because its code was updated`. Consult the D1 error list ("Recommended action" column) for others.
- `@cloudflare/actors` provides `tryWhile` for this, or copy the logic. A ready version is in `assets/d1-helpers.ts`.

## Scaling out

1. Fix queries and indexes first: throughput is `1/latency`.
2. Batch related statements; cache hot reads (KV, Cache API) where staleness is acceptable.
3. Enable read replication and move reads to `withSession()` for read-heavy global apps.
4. Shard by tenant/user/entity across many databases (each up to 10 GB). Bind up to about 5,000 databases to one Worker script, or resolve databases dynamically; request higher account limits for millions of databases.
5. Anything single-write-hot (counters, queues) will bottleneck on the single writer regardless; consider Durable Objects or Queues for those.
