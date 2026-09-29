---
name: cloudflare-d1
description: Build, query, migrate, optimize and scale Cloudflare D1 (serverless SQLite) databases from Workers. Covers the Workers Binding API (prepare/bind/run/all/first/raw/batch/exec, Sessions API and read replication), SQL and PRAGMA support, JSON functions, generated columns, foreign keys, indexes and query cost, migrations, import/export, retries, limits and wrangler d1 commands. Make sure to use this skill whenever the user mentions D1, Cloudflare D1, wrangler d1, env.DB, D1Database, D1PreparedStatement, d1_databases in wrangler config, SQLite on Cloudflare Workers, D1 migrations, Drizzle or Kysely on D1, read replicas or bookmarks, "rows read" billing, or D1 errors (overloaded, statement too long, FOREIGN KEY constraint failed, D1_TYPE_ERROR), even if they do not say "D1" explicitly but are using a Worker with a SQLite-style binding.
---

# Cloudflare D1

D1 is Cloudflare's managed serverless SQL database. It runs SQLite's query engine, so SQLite syntax and semantics apply, but the hosting model (one single-threaded primary per database, implicit transactions, row-based billing, Worker-only binding API) changes how you should design and write queries. This skill captures those differences so you write code that is correct, fast and cheap on the first try.

Docs snapshot: read from developers.cloudflare.com on 2026-09-29. Platform numbers (limits, pricing, regions) change; when a decision depends on one, verify against the live page (each docs page has an `index.md` variant and there is an index at `https://developers.cloudflare.com/d1/llms.txt`).

## Mental model (these facts drive most decisions)

- **One database = one single-threaded primary.** Throughput is roughly `1 / average query time`: 1 ms queries give about 1,000 qps, 100 ms queries about 10 qps. Slow queries do not just hurt one request, they queue everyone. Overflow returns an "overloaded" error.
- **Scale out by adding databases, not by growing one.** Max 10 GB per database (cannot be raised), up to 50,000 databases per account on Workers Paid. Per-tenant/per-user databases are the intended pattern.
- **Billing is rows read and rows written, not rows returned.** A full scan that returns one row is billed for every row scanned. Indexes reduce both latency and cost. Check `meta.rows_read` / `meta.rows_written` on any result.
- **Every query runs in an implicit transaction; `batch()` is a transaction.** No `BEGIN`/`COMMIT` in SQL you send. Foreign keys are always enforced.
- **Writes always go to the primary.** Read replicas only help reads, and only if you use the Sessions API (`withSession`).
- **Values are converted on write.** JS `Number` becomes REAL or INTEGER, booleans become 0/1, `undefined` throws `D1_TYPE_ERROR`. Prefer `STRICT` tables.

## Quick start

```bash
npx wrangler d1 create prod-db                # optional: --location=weur (hint for primary location)
```

Do **not** pass `--experimental-backend`. That flag came from the May 2023 rollout of the new storage backend, which has been the default since 2023-07-27 per the release notes, so it is unnecessary. (How current wrangler treats the flag is unverified; just omit it.)

Bind it in `wrangler.jsonc` (or the equivalent TOML):

```jsonc
{
  "d1_databases": [{
    "binding": "DB",                 // becomes env.DB
    "database_name": "prod-db",
    "database_id": "<UUID from create output>",
    "migrations_dir": "migrations"   // default
  }]
}
```

```bash
npx wrangler types                                   # generates typed Env (D1Database)
npx wrangler d1 migrations create prod-db init       # creates migrations/0001_init.sql
npx wrangler d1 migrations apply prod-db --local     # apply locally
npx wrangler d1 migrations apply prod-db --remote    # apply to production
```

```ts
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const row = await env.DB
      .prepare("SELECT id, email FROM users WHERE id = ?1")
      .bind(42)
      .first<{ id: number; email: string }>();   // null if no row
    return Response.json(row);
  },
} satisfies ExportedHandler<Env>;
```

`wrangler d1 execute` and `migrations apply` default to the **local** database (since wrangler 3.33). Add `--remote` explicitly for production, and say which one you are targeting whenever you give the user a command.

## Core rules

1. **Always `prepare(...).bind(...)`; never string-interpolate values.** Binding prevents SQL injection and lets statements be reused. Only `?` and `?NNN` placeholders are supported (no `:name` / `@name` yet). Prefer `?1, ?2` over bare `?` because miscounting is easy.
2. **Max 100 bound parameters per query.** For large `IN (...)` lists or bulk inserts, pass one JSON string and expand with `json_each(?1)`; see `references/sql-reference.md`.
3. **Use `batch()` for multiple statements** to save round trips and get atomicity: if any statement fails the whole batch rolls back. Limits apply per statement inside a batch, and the whole batch must finish within 30 s.
4. **Use `exec()` only for maintenance/one-shot SQL.** It takes unbound SQL, is less safe and slower, and stops at the first error.
5. **Pick the result method deliberately:** `run()`/`all()` (same thing) return `{ success, meta, results }`; `first()` returns one row or `null` (add `LIMIT 1` yourself, it does not change the SQL); `raw()` returns arrays of arrays, which is the correct choice when joins produce duplicate column names. `results` is empty for INSERT/UPDATE/DELETE; read `meta.changes` / `meta.last_row_id` instead.
6. **Never pass `undefined` to `bind`.** Convert to `null`. Booleans read back as `0`/`1`. `BigInt` is unsupported and integers above `Number.MAX_SAFE_INTEGER` lose precision on read, so store big IDs as TEXT.
7. **Index what you filter, join and sort on**, verify with `EXPLAIN QUERY PLAN` (want `SEARCH ... USING INDEX`, not `SCAN`), and run `PRAGMA optimize` after schema changes. `INTEGER PRIMARY KEY` needs no extra index.
8. **Do schema changes through migrations, once, not per request.** Building an index writes every indexed row and writes cost more than reads.
9. **Retry transient failures yourself for writes** (exponential backoff with jitter, only when the operation is idempotent). D1 auto-retries read-only queries (`SELECT`, `EXPLAIN`, `WITH`) up to two extra times; see `meta.total_attempts`.
10. **Big data changes go in chunks** (about 1,000 rows at a time). A single UPDATE/DELETE touching hundreds of thousands of rows will exceed execution limits. `LIMIT` is supported on UPDATE and DELETE.
11. **Quote identifiers that are English words** (`"order"`, `"group"`, `"key"`). SQLite adds keywords over time; run `python scripts/check_identifiers.py <names...>` to check.
12. **Read replication requires `withSession()`.** Without it every query hits the primary. Pass the bookmark between requests (e.g. `x-d1-bookmark` header or cookie) to keep read-your-writes across requests.

## Which reference to read

| The task involves... | Read |
|---|---|
| Worker code: prepare/bind/run/first/raw/batch/exec, return objects, TypeScript generics, type conversion, Sessions API, error handling | `references/worker-api.md` |
| SQL dialect specifics: supported extensions (FTS5, JSON, math), PRAGMAs, JSON functions, `json_each` tricks, generated columns, determinism rules, foreign keys and actions, keyword quoting | `references/sql-reference.md` |
| Slow or expensive queries, index design, EXPLAIN, billing patterns, limits, concurrency, read replication setup, retries | `references/performance-and-scaling.md` |
| wrangler commands, migrations (incl. Drizzle nested layout), import/export, converting SQLite dumps, FK handling in migrations, changelog and deprecated things | `references/operations.md` |
| Ready-to-copy TypeScript helpers (retry wrapper, session-per-request, chunked batch, JSON bulk insert) | `assets/d1-helpers.ts` |

Load only what the task needs. For a simple query question, this file is enough.

## Workflows

### Designing a schema
1. Use `STRICT` tables and explicit types (`INTEGER`, `TEXT`, `REAL`, `BLOB`) so stored values match what you think is stored.
2. Use `INTEGER PRIMARY KEY` for surrogate keys when possible (rowid alias, no extra index). Use TEXT ids (ULID/UUID) only when you need client-generated or non-guessable ids.
3. Declare foreign keys with explicit `ON DELETE` actions. Prefer `RESTRICT` or `SET NULL` unless deleting children is truly intended; `CASCADE` can silently remove data other users still need.
4. Add indexes for every predicate/join column on hot paths. Use multi-column indexes with the equality column first (leftmost-prefix rule), and partial indexes (`WHERE status != 6`) to skip rows you never query.
5. For JSON you filter on often, add a `STORED` generated column extracting the field and index it.
6. Put the DDL in a migration file, not in application code.

### Writing or reviewing a query
1. Is every value bound, with no `undefined`?
2. Does `EXPLAIN QUERY PLAN` show an index search? If not, which index is missing?
3. Leading-wildcard `LIKE '%x%'`, `ORDER BY RANDOM()`, `OFFSET` on big tables, and correlated subqueries over unindexed columns all read many rows. Suggest alternatives (prefix search, FTS5 trigram, keyset pagination on an indexed column).
4. Could several statements be one `batch()`?
5. Is it read-only and latency-sensitive from many regions? Consider `withSession()` with read replication.

### Debugging cost or latency
1. Log `result.meta` (`rows_read`, `rows_written`, `duration`, `timings.sql_duration_ms`, `served_by_region`, `served_by_primary`).
2. Rank queries by `rows_read / rows returned` and by call frequency; fix the frequent, wasteful ones first.
3. Look for per-request schema changes, missing join indexes, full scans, and `LIKE '%..%'`.
4. After adding an index: `PRAGMA optimize;` then re-check the plan.

### Migrating or importing data
1. Schema changes: migrations (`references/operations.md`). Test with `--local` first, then `--remote`.
2. Foreign key violations mid-migration: put `PRAGMA defer_foreign_keys = on` at the top of the file. Violations left at the end still fail the transaction.
3. Importing from SQLite: `.dump`, remove `BEGIN TRANSACTION`/`COMMIT` and the `_cf_KV` table, then `wrangler d1 execute --remote --file`. MySQL/Postgres dumps are not directly importable.
4. "Statement too long" (100 KB per statement): split big `INSERT ... VALUES` into smaller ones.

## Common errors, quickly

| Symptom | Likely cause and fix |
|---|---|
| `D1_TYPE_ERROR` | `undefined` (or unsupported type) in `bind()`. Use `null`. |
| `FOREIGN KEY constraint failed` | Violation at end of transaction. Fix data or ordering, or `PRAGMA defer_foreign_keys = on` earlier in the same transaction/migration. |
| `cannot start a transaction within a transaction` | Imported SQL still contains `BEGIN TRANSACTION`/`COMMIT`. Remove them. |
| `Statement too long` | A single statement exceeds 100,000 bytes. Split it. |
| "overloaded" | Too many concurrent queries for one single-threaded DB. Speed up queries (indexes), batch, cache, or shard across databases. |
| `malformed JSON` | A `json_*` function got non-JSON text. Guard with `json_valid(col)`. |
| Stale reads after a write | Replica lag. Use `withSession()` and pass the bookmark. |
| Missing rows after "successful" local test | You ran against local state; add `--remote` for production. |
| `Network connection lost`, `storage caused object to be reset`, `reset because its code was updated` | Transient; retry idempotent operations with backoff. |
