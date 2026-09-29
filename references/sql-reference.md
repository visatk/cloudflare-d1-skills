# D1 SQL reference

Sources: SQL statements, foreign keys, query JSON, generated columns (developers.cloudflare.com/d1), sqlite.org deterministic functions and keywords.

## Contents
- Supported extensions
- PRAGMA support
- Introspection queries
- Foreign keys
- JSON functions
- Generated columns
- Deterministic functions
- Keywords and quoting
- LIKE, search and FTS5

## Supported extensions

D1 uses SQLite's engine and supports a subset of extensions:
- **FTS5** full-text search (including `fts5vocab`). Note: databases with virtual tables cannot be exported with `wrangler d1 export` (see `operations.md`).
- **JSON extension** (`json_*` functions, `->`, `->>`).
- **Math functions** (`sqrt`, `pow`, `ceil`, ...).

The authoritative function list is in the workerd source (`src/workerd/util/sqlite.c++`). If a SQLite function is missing, it is probably not compiled in.

Also supported: `LIMIT` on `UPDATE` and `DELETE` (a useful guardrail), generated columns, `STRICT` tables, partial indexes, `EXPLAIN QUERY PLAN`.

## PRAGMA support

Key caveat: **D1 PRAGMA statements only apply to the current transaction**, and PRAGMAs cannot read table contents.

Introspection:

| Statement | Purpose |
|---|---|
| `PRAGMA table_list` | Tables/views in the DB, including D1 system tables. Columns: schema, name, type (`table`,`view`,`shadow`,`virtual`), ncol, wr (WITHOUT ROWID), strict |
| `PRAGMA table_info("T")` | Columns of T: cid, name, type, notnull, dflt_value, pk. Note: `notnull` is `1` when the column is NOT NULL (the docs prose describes it inverted, but the docs' own output shows `1` for NOT NULL columns) |
| `PRAGMA table_xinfo("T")` | Like table_info plus generated/hidden columns (`hidden` column) |
| `PRAGMA index_list("T")` | Indexes on T: seq, name, unique, origin (`c` CREATE INDEX, `u` UNIQUE, `pk` primary key), partial |
| `PRAGMA index_info(idx)` | Indexed columns: seqno, cid, name |
| `PRAGMA index_xinfo("idx")` | index_info plus hidden columns (desc, coll, key) |
| `PRAGMA quick_check` | Integrity check; returns `ok` or a description of problems |
| `PRAGMA foreign_key_check` | Rows violating foreign keys |
| `PRAGMA foreign_key_list("T")` | FK constraints on T |

Behavior toggles (transaction-scoped):

| Statement | Effect |
|---|---|
| `PRAGMA case_sensitive_like = on/off` | `on`: `'a' LIKE 'A'` is false. Default off (case-insensitive) |
| `PRAGMA ignore_check_constraints = on/off` | Skip CHECK enforcement when on |
| `PRAGMA legacy_alter_table = on/off` | Old ALTER TABLE RENAME behavior when on |
| `PRAGMA recursive_triggers = on/off` | Whether triggers can fire other triggers |
| `PRAGMA reverse_unordered_selects = on/off` | Reverses row order of SELECTs without ORDER BY (handy to expose code that wrongly depends on implicit order) |
| `PRAGMA foreign_keys = on/off` | Documented, but D1 always enforces FKs and user queries cannot change this mid-query; use `defer_foreign_keys` instead |
| `PRAGMA defer_foreign_keys = on/off` | Defer FK checks to end of the current transaction (below) |
| `PRAGMA optimize` | Runs `ANALYZE` where useful (time-limited), improving planner statistics. Run after schema changes such as creating an index. `PRAGMA optimize(-1)` (dry run) is **not supported** |

`sqlite_master` / `sqlite_schema` list objects and their DDL: `SELECT name, type, sql FROM sqlite_schema WHERE type = 'index';`. You cannot modify it. `_cf_KV` is a reserved D1 internal table: not queryable, not billed.

## Foreign keys

D1 enforces foreign keys in every query and migration, equivalent to `PRAGMA foreign_keys = on`.

```sql
CREATE TABLE users (
  user_id INTEGER PRIMARY KEY,
  email_address TEXT
);
CREATE TABLE orders (
  order_id INTEGER PRIMARY KEY,
  user_who_ordered INTEGER,
  FOREIGN KEY (user_who_ordered) REFERENCES users(user_id) ON DELETE RESTRICT
);
```

Can be defined in `CREATE TABLE` or when adding a column with `ALTER TABLE`. Multiple FKs per table and references to multiple tables are fine.

**Actions** (for `ON UPDATE` and/or `ON DELETE`, chosen independently):
- `CASCADE`: updating/deleting the parent updates/deletes children. Powerful and dangerous: deleting a user also deletes rows other users may still reference.
- `RESTRICT`: parent cannot be changed while any child refers to it; errors immediately (not at end of transaction).
- `SET NULL`: child columns become NULL.
- `SET DEFAULT`: child columns take their schema `DEFAULT`; unusable if no default is defined.
- `NO ACTION`: do nothing (default; violations are checked at end of the statement/transaction).

**Deferring checks** (schema changes, imports, reorderings that are temporarily inconsistent):

```sql
PRAGMA defer_foreign_keys = on;
-- statements that temporarily violate constraints
-- (setting it back to off is implicit at transaction end)
```

- Lasts only for the current transaction; it does not disable enforcement.
- Any violation still outstanding at commit fails with `FOREIGN KEY constraint failed`. You may set `off` early to force the check as soon as you have repaired the data.
- It does **not** stop `ON DELETE CASCADE` actions from running.
- The migrations and import docs say `PRAGMA defer_foreign_keys = true`; `on`, `true`, and `1` are all standard SQLite boolean spellings.

## JSON functions

JSON lives in `TEXT` columns. Mapping: JSON null -> SQL NULL, numbers -> INTEGER/REAL, `true`/`false` -> 1/0, objects and arrays -> TEXT. Doing JSON work in SQL saves round trips (no read-modify-write from the Worker) and shrinks result sets.

`path` syntax: `$` root, `$.a.b` nested key, `$.list[0]` array element (zero-based), `$.list[#]` one past the end (append position; `[#-1]` is the last element).

| Function | Use |
|---|---|
| `json(x)` | Validate and minify |
| `json_valid(x)` | 1/0 |
| `json_array(v1, v2, ...)`, `json_object(k1, v1, ...)` | Build JSON |
| `json_extract(json, path)` | Extract; scalars come back as SQL values, objects/arrays as JSON text |
| `json -> path` | Extract as JSON (a string comes back quoted) |
| `json ->> path` | Extract as a SQL value (preferred for WHERE/ORDER BY) |
| `json_array_length(json[, path])` | Array length |
| `json_type(json[, path])` | `null,true,false,integer,real,text,array,object` |
| `json_insert(json, path, value)` | Add only if the key is absent |
| `json_replace(json, path, value)` | Overwrite only if the key exists |
| `json_set(json, path, value)` | Insert or overwrite |
| `json_remove(json, path, ...)` | Delete keys/elements |
| `json_patch(target, patch)` | RFC 7396 MergePatch |
| `json_quote(v)` | SQL value to JSON |
| `json_group_array(v)` | Aggregate rows into an array |
| `json_each(x[, path])`, `json_tree(x[, path])` | Table-valued: one row per element. `each` is one level, `tree` walks everything. Columns: `key`, `value`, `type`, `atom`, `id`, `parent`, `fullkey`, `path` |

Argument rules: string literals passed as `value` are treated as strings even if they look like JSON, except when nested inside another `json_*` call (the outer function then treats the inner result as JSON).

Invalid JSON raises `malformed JSON` (D1 error code 9015). Guard with `WHERE json_valid(col)` if the column can contain non-JSON.

Examples:

```sql
-- Extract
SELECT json_extract(sensor_reading, '$.measurement.temp_f') FROM readings;
SELECT sensor_reading ->> '$.measurement.aqi[2]' FROM readings;   -- zero-based

-- Filter on array length
SELECT * FROM users WHERE json_array_length(login_history, '$.history') >= 5;

-- Append to an array without reading it into the Worker
UPDATE users
SET login_history = json_insert(login_history, '$.history[#]', '2023-05-15T20:33:06+00:00')
WHERE user_id = ?1;
```

**Bulk operations with one bound parameter** (sidesteps the 100-parameter limit; the JSON string is bound rather than inlined, so it counts against the 2 MB string/row limit, not the 100 KB statement limit):

```ts
// IN-list of any length
await env.DB
  .prepare("UPDATE users SET last_audited = ?1 WHERE id IN (SELECT value FROM json_each(?2))")
  .bind(new Date().toISOString(), JSON.stringify([183183, 13913, 94944]))
  .run();

// Bulk insert of objects
await env.DB
  .prepare(`INSERT INTO items (sku, qty)
            SELECT json_extract(value, '$.sku'), json_extract(value, '$.qty')
            FROM json_each(?1)`)
  .bind(JSON.stringify(rows))
  .run();
```

## Generated columns

Columns computed from other columns in the same row (including `json_extract`, `date(...)`, arithmetic).

```sql
CREATE TABLE sensor_readings (
  event_id INTEGER PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  raw_data TEXT,
  location AS (json_extract(raw_data, '$.measurement.location')) STORED
);
CREATE INDEX idx_sensor_readings_location ON sensor_readings(location);
```

- `VIRTUAL` (default): computed on read, no storage, more CPU per query.
- `STORED`: computed on write, occupies storage, faster reads. Recommended when the expression is expensive (e.g. parsing large JSON).
- Long form: `col GENERATED ALWAYS AS (expr) [STORED|VIRTUAL]`; `GENERATED ALWAYS` is optional.
- Can be indexed, which is the standard recipe for fast filtering on JSON fields.
- **Adding to an existing table:** `ALTER TABLE t ADD COLUMN c AS (expr)` works but must be `VIRTUAL`. A `STORED` column cannot be added with ALTER; rebuild the table in a migration instead.
- Definitions cannot be edited in place. To change one: drop the column and add it again, or rename the old one and add a new definition.
- A table needs at least one non-generated column.
- Expression may only reference the same row's columns and only deterministic functions. No `random()`, subqueries or aggregates.
- Handy examples: `formatted_date AS (date(timestamp, 'unixepoch'))`, `expires_at AS (date(timestamp, '+30 days'))`. Do not put `'now'` in the expression; compare against the current date in the query instead (`WHERE date('now') > expires_at`).

## Deterministic functions

A deterministic function returns the same output for the same inputs. Non-deterministic functions are **rejected or unsafe** in: generated column expressions, expression indexes, partial-index `WHERE` clauses, and CHECK constraints. (For CHECK, SQLite does not actually reject them because of a historical bug kept for backwards compatibility, but behavior is unspecified. Do not do it.)

Non-deterministic: `random()`, `changes()`, `last_insert_rowid()`, `sqlite_version()`, and date/time functions when given `'now'`, the `localtime` modifier, or the `utc` modifier, including the no-argument forms like `datetime()` (which equal `'now'`). Date/time functions with explicit fixed inputs and modifiers such as `'unixepoch'`, `'+30 days'` are deterministic.

Why it matters: indexes store computed values in a B-tree. If a function later returned something different, the index would silently disagree with the table. D1's index docs state you cannot create indexes referencing other tables or using non-deterministic functions.

## Keywords and quoting

SQLite has 147 keywords and adds more over time. If an identifier is an English word, quote it. Ways to quote an identifier:
- `"name"` double quotes (standard, preferred)
- `[name]` (SQL Server style) and `` `name` `` (MySQL style), for compatibility

Single quotes (`'name'`) are string literals. SQLite bends the rules in odd cases (a single-quoted keyword where only an identifier is legal is read as an identifier; a double-quoted name that resolves to nothing becomes a string literal), which hides typos. Do not rely on either exception.

Check candidates with the bundled script:

```bash
python scripts/check_identifiers.py order group key user_id
python scripts/check_identifiers.py --scan migrations/0001_init.sql
python scripts/check_identifiers.py --list
```

Frequently hit keywords: `order`, `group`, `index`, `key`, `values`, `default`, `transaction`, `table`, `check`, `references`, `action`, `end`, `plan`, `query`, `row`, `rows`, `range`, `window`, `over`, `filter`, `match`, `temp`, `first`, `last`, `no`, `do`, `of`, `by`, `to`, `is`, `in`, `like`, `glob`, `regexp`, `replace`.

## LIKE, search and FTS5

- `LIKE` is case-insensitive by default; `PRAGMA case_sensitive_like = on` flips it for the transaction.
- `LIKE`/`GLOB` patterns are limited to 50 bytes.
- Leading-wildcard `LIKE '%term%'` cannot use a B-tree index and scans the table. Prefer prefix search `LIKE 'term%'` (can use an index in some cases), or FTS5 (with the `trigram` tokenizer for arbitrary substring search on patterns of 3+ non-wildcard characters). FTS5 adds storage and write cost; benchmark and verify with `EXPLAIN QUERY PLAN`.

```ts
const { results } = await env.DB
  .prepare("SELECT * FROM Customers WHERE CompanyName LIKE ?1")
  .bind("eve%")
  .run();
```
