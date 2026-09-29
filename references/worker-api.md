# D1 Workers Binding API reference

Sources: worker-api overview, D1Database, prepared statements, return objects (developers.cloudflare.com/d1/worker-api/).

## Contents
- Flow and binding
- TypeScript
- Type conversion
- D1Database methods: prepare, batch, exec, dump, withSession
- D1PreparedStatement methods: bind, run/all, raw, first
- Return objects and `meta`
- Sessions API and bookmarks
- Errors
- Python Workers

## Flow and binding

1. Bind the database in the Wrangler config (`binding: "DB"` gives `env.DB`).
2. `env.DB.prepare(sql)` returns a `D1PreparedStatement`.
3. Optionally `.bind(...values)`, which returns a new statement.
4. Execute with `.run()`, `.all()`, `.first()`, `.raw()`, or pass statements to `env.DB.batch([...])`.
5. Inspect the returned object (`success`, `meta`, `results`).

The binding is on `env`, so inside a `fetch(request, env)` handler use `env.DB`. In a Python Worker it is `self.env.DB`.

## TypeScript

Run `npx wrangler types` to generate the `Env` interface with `DB: D1Database`. `run`, `all`, `raw` and `first` accept a row type parameter:

```ts
type OrderRow = { Id: string; CustomerName: string; OrderDate: number };

const { results } = await env.DB
  .prepare("SELECT Id, CustomerName, OrderDate FROM [Order] ORDER BY ShippedDate DESC LIMIT 100")
  .run<OrderRow>();          // results: OrderRow[]

const one = await stmt.first<OrderRow>();          // OrderRow | null
const col = await stmt.first<number>("CustomerId"); // one column value
const rows = await stmt.raw<[number, string]>();    // arrays of arrays
```

Since `@cloudflare/workers-types` 4.20240725.0 the `run()` type is correct (`D1Result<T>` including rows). Older versions typed it as metadata-only; upgrade the types package if you see that.

## Type conversion (permanent and one-way)

| JS value written | Stored as | JS value read back |
|---|---|---|
| `null` | NULL | `null` |
| `number` (float) | REAL | `number` |
| `number` (integer) | INTEGER | `number` |
| `string` | TEXT | `string` |
| `boolean` | INTEGER (1/0) | `number` (0/1) |
| `ArrayBuffer` / view | BLOB | `number[]` (via `Array.from`) |
| `undefined` | not supported: throws `D1_TYPE_ERROR` | n/a |

- What you read back is the converted value, not the original.
- 64-bit integers exist in storage, but BigInt is not supported in the API and values above `Number.MAX_SAFE_INTEGER` may lose precision when read. Store such values as TEXT.
- Use `STRICT` tables so column types are enforced and do not drift from what you expect.

## `D1Database` methods

### `prepare(query: string): D1PreparedStatement`
Compiles the statement. Reuse the same prepared statement with different `bind()` calls, e.g. in a batch:

```ts
const stmt = env.DB.prepare("SELECT * FROM Customers WHERE CompanyName = ?1");
const [a, b] = await env.DB.batch([stmt.bind("Bs Beverages"), stmt.bind("Around the Horn")]);
```

A statement with hard-coded values (a "static statement") works, but bound parameters are the recommended path: reusable and injection-safe.

### `batch(statements: D1PreparedStatement[]): Promise<D1Result[]>`
- Sends all statements in one call, so you pay one network round trip.
- Statements execute sequentially, never concurrently, and the batch is a SQL transaction.
- If any statement fails, an error is returned for that statement and the **entire sequence is rolled back**.
- Results come back in the same order as the input statements.
- Per-statement limits (100 KB SQL, 100 bound params, ...) apply to each statement; the 30 s API limit applies to the whole batch.
- Because statements run in order in one transaction, a later statement can rely on SQL state from an earlier one (for example `last_insert_rowid()`).

```ts
const [ins, audit] = await env.DB.batch([
  env.DB.prepare("INSERT INTO users (email) VALUES (?1)").bind(email),
  env.DB.prepare("INSERT INTO audit (user_id, msg) VALUES (last_insert_rowid(), ?1)").bind("created"),
]);
console.log(ins.meta.last_row_id, audit.meta.changes);
```

### `exec(query: string): Promise<D1ExecResult>`
- Runs one or more raw SQL statements, no binding. Multiple statements are separated by newlines (`\n`).
- Returns `{ count, duration }` only, with no rows.
- Throws on error with query and error text; later statements are not executed.
- Use for maintenance and one-off jobs (migration-style scripts). Slower and less safe than prepared statements.

### `dump()`
Returns an ArrayBuffer SQLite-compatible dump, but **only works on databases created during the alpha period** (alpha databases no longer accept queries). For current databases use `wrangler d1 export`.

### `withSession(constraintOrBookmark?): D1DatabaseSession`
Starts a session giving sequential consistency across queries (see Sessions API below).

## `D1PreparedStatement` methods

### `bind(...values): D1PreparedStatement`
Returns a new statement with parameters attached.

Placeholders:
- `?` anonymous. Number is one more than the largest already assigned. Discouraged: easy to miscount.
- `?NNN` ordered, e.g. `?2`, `?1`. `NNN` must be between 1 and `SQLITE_MAX_VARIABLE_NUMBER`. Reusing `?1` in several places is allowed and needs the value only once.
- Named parameters (`:name`, `@name`, `$name`) are **not supported yet**.
- Limit: 100 bound parameters per query.

```ts
db.prepare("SELECT * FROM Customers WHERE CompanyName = ?2 AND CustomerId = ?1").bind(1, "Alfreds Futterkiste");
```

### `run<T>()` / `all<T>()` -> `D1Result<T>`
`all()` is an alias of `run()`. Returns `{ success, meta, results }`. `results` is `[]` for writes. Take `.results` if you only want rows.

### `raw<T>({ columnNames?: boolean })` -> `T[]` (array of arrays)
No metadata. `raw({ columnNames: true })` prepends a header row of column names. Use it when result columns may share names (joins), because object results collapse duplicates. Since 2024-02-13 `raw()` returns arrays of arrays; code written for the older object-returning behavior breaks.

### `first<T>(columnName?)` -> `T | null`
Returns the first row (or one column of it) with no metadata; `null` if there are no rows. Throws `D1_ERROR` if the row exists but the named column does not. It does not alter the SQL, so add `LIMIT 1` yourself.

## Return objects

### `D1Result` (from `run`/`all` and each entry of `batch`)

```ts
{
  success: boolean,
  results: T[] | null,            // [] if empty, null if not applicable
  meta: {
    served_by: string,            // backend version that handled the query
    served_by_region: string,     // region of the instance that executed it
    served_by_primary: boolean,   // true only if the primary served it
    timings: { sql_duration_ms: number },  // SQL execution time, no network
    duration: number,             // SQL execution time in ms
    changes: number,              // rows changed
    last_row_id: number,          // last inserted rowid (not for WITHOUT ROWID tables)
    changed_db: boolean,
    size_after: number,           // DB size in bytes after the query
    rows_read: number,            // rows scanned  (billing metric)
    rows_written: number,         // rows written  (billing metric)
    total_attempts: number        // executions including retries
  }
}
```

`served_by_region` / `served_by_primary` are present for all remote requests, but `undefined` under `wrangler dev` (local).

### `D1ExecResult` (from `exec`)
`{ count: number, duration: number }`.

## Sessions API and bookmarks

```ts
const bookmark = request.headers.get("x-d1-bookmark") ?? "first-unconstrained";
const session = env.DB.withSession(bookmark);          // synchronous
const { results } = await session.prepare("SELECT ...").bind(...).all();
response.headers.set("x-d1-bookmark", session.getBookmark() ?? "");
```

`withSession(arg)`:
- omitted / `"first-unconstrained"` (default): first query may go to any instance (primary or replica). Lowest latency, possibly stale start.
- `"first-primary"`: first query (read or write) goes to the primary, so the session starts from the latest data; later queries may use replicas.
- a **bookmark string** from a previous session: the new session starts at a database version at least as new as that bookmark.

`D1DatabaseSession` has `prepare()`, `batch()` (same as on `D1Database`) and `getBookmark()` (`string | null`; `null` if no query has run yet).

All queries in a session are sequentially consistent: monotonic reads, monotonic writes, writes follow reads, read-your-own-writes. Sessions work even when read replication is disabled, so it is safe to adopt them before enabling replicas. Sessions are Worker-binding only (not in the REST API). Setup and consistency background is in `performance-and-scaling.md`.

## Errors

- Errors surface in `Error.message` (the older `Error.cause` was deprecated in mid-2023).
- Common: `D1_TYPE_ERROR` (bad bound value), `D1_ERROR` (for example `first(col)` on a missing column), SQL engine errors (`malformed JSON`, FK failures), "overloaded" (too many concurrent queries for one database), and transient network/reset errors worth retrying.
- Write failure in `batch()` rolls back everything; you will not see partial application.
- For retry logic see `assets/d1-helpers.ts` and `performance-and-scaling.md`.

## Python Workers

Same API through `self.env.DB`: `prepare(...).bind(...)`, `await stmt.run()`, `await stmt.raw()`, `await stmt.first()`, `await self.env.DB.batch([...])`, `withSession(...)`. Results are JS proxies; convert with `.to_py()` (e.g. `result.results.to_py()`). `raw(columnNames=True)` is the keyword form.
