# D1 operations: wrangler, migrations, import/export, changelog

Sources: migrations, import-export-data, query-d1, release notes, "D1: We turned it up to 11" blog (developers.cloudflare.com/d1/, blog.cloudflare.com).

## Contents
- Ways to talk to D1
- Wrangler cheat sheet
- Migrations
- Import an existing database
- Export a D1 database
- Foreign keys during migrations and imports
- Changelog highlights and deprecated things
- Historical blog notes (what is outdated)

## Ways to talk to D1

1. **Workers Binding API** (data plane): queries from your Worker code. See `worker-api.md`.
2. **REST API** (control plane, plus `/query` and `/raw`): create/manage databases, run SQL over HTTP. Writes need an API token with `D1:Edit`; `D1:Read` is read-only (a 2025 fix closed a hole where read tokens could write). Overloaded databases return HTTP 429; invalid SQL returns 400.
3. **Wrangler CLI**: uses the REST API under the hood. Best for setup, migrations, one-off SQL, import/export.

## Wrangler cheat sheet

```bash
# create (do not add --experimental-backend; it is the default backend)
npx wrangler d1 create prod-db
npx wrangler d1 create eu-users-db --location=weur     # location hint for the primary

npx wrangler d1 info prod-db                           # metadata (version, size)
npx wrangler d1 list

# run SQL: LOCAL by default; add --remote for production
npx wrangler d1 execute prod-db --command="SELECT name FROM sqlite_schema WHERE type='table'"
npx wrangler d1 execute prod-db --remote --command="PRAGMA table_list"
npx wrangler d1 execute prod-db --remote --file=./seed.sql

# migrations
npx wrangler d1 migrations create prod-db add_users_table
npx wrangler d1 migrations list prod-db --remote
npx wrangler d1 migrations apply prod-db --remote

# export / import
npx wrangler d1 export prod-db --remote --output=./database.sql

# point-in-time restore (Time Travel) - check current flags with:
npx wrangler d1 time-travel --help

# local dev with a local D1 (state under .wrangler/state)
npx wrangler dev
```

Notes:
- `wrangler d1 execute` and `migrations apply` default to local since wrangler 3.33.0 (2024-03-12). Always state `--local` or `--remote` when giving commands.
- You can identify the database by binding name or database name in migration commands; prefer the **database name**, because binding names can change and you might apply to the wrong database.
- Locations: hints are `wnam`, `enam`, `weur`, `eeur`, `apac`, `oc`. A location hint influences where the primary (writer) lives; without it D1 infers from where you run `create`. A jurisdiction can also be set at creation for data-localization guarantees (added 2025-11-05); check `wrangler d1 create --help` for the exact flag.
- Remote `execute --file` imports are limited to 5 GiB (uploaded via R2).

Binding config (wrangler.jsonc):

```jsonc
{
  "d1_databases": [{
    "binding": "DB",
    "database_name": "prod-db",
    "database_id": "<UUID>",
    "preview_database_id": "<UUID>",       // optional: DB used by preview/dev
    "migrations_dir": "migrations",        // default
    "migrations_table": "d1_migrations",   // default table tracking applied migrations
    "migrations_pattern": "migrations/*/migration.sql"  // optional glob for nested layouts
  }]
}
```

## Migrations

- Each migration is a `.sql` file in `migrations/` with a numeric prefix in its filename (`0001_init.sql`, `0002_add_index.sql`); files apply in sequential order.
- Applied migrations are recorded in the `d1_migrations` table in the database (name configurable with `migrations_table`).
- Commands: `create` (empty file), `list` (unapplied), `apply` (run the remaining ones).
- Put schema changes here, not in request handlers. Index builds and DDL on every request are billed writes.
- Do not include `BEGIN`/`COMMIT` in migration or import files: D1 already runs statements inside its own transaction, and leftover ones cause `cannot start a transaction within a transaction`.
- Test order: `apply --local`, run the app against it, then `apply --remote`.

**Nested layouts (Drizzle and similar).** By default wrangler only reads top-level `.sql` files in `migrations_dir`. Drizzle can write `migrations/0001_init/migration.sql`. Configure:

```jsonc
"migrations_dir": "migrations",
"migrations_pattern": "migrations/*/migration.sql"
```

Rules: setting `migrations_pattern` requires `migrations_dir`; the pattern must start with `migrations_dir`; `*` matches one path segment, `**` any number; the recorded migration name is the path relative to `migrations_dir` (e.g. `0001_init/migration.sql`). `wrangler d1 migrations create` only writes top-level files, so for a nested pattern generate migrations with the ORM (`drizzle-kit generate`) and apply with wrangler.

**Foreign keys inside migrations:** see below.

## Import an existing database

Prerequisites: Wrangler installed, a target D1 database, and SQL text to run. You cannot import a raw `.sqlite3` file directly.

```bash
npx wrangler d1 execute prod-db --remote --file=users_export.sql
npx wrangler d1 execute prod-db --remote --command "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name;"
```

### Convert a raw SQLite database

```bash
sqlite3 db_dump.sqlite3 .dump > db.sql
```

Then edit `db.sql`:
1. Remove `BEGIN TRANSACTION` and `COMMIT;`.
2. Remove `CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID;` if present (reserved D1 table).

Then run it with `d1 execute --file`.

### Troubleshooting imports
- Must be SQL text. MySQL and PostgreSQL dumps are **not** directly compatible (types and syntax differ); convert to SQLite syntax first.
- Create tables in dependency order (cannot reference a table that does not exist yet), or defer FKs (below).
- `cannot start a transaction within a transaction`: leftover `BEGIN TRANSACTION`/`COMMIT`.
- `Statement too long`: one statement is over 100,000 bytes. Split a giant multi-row `INSERT` into several statements (e.g. groups of 100 to 250 rows).
- Very large imports: more than 5 GiB must be split into multiple files.

## Export a D1 database

```bash
npx wrangler d1 export prod-db --remote --output=./database.sql                          # schema + data
npx wrangler d1 export prod-db --remote --table=users --output=./users.sql               # one table
npx wrangler d1 export prod-db --remote --output=./schema.sql --no-data                  # schema only
npx wrangler d1 export prod-db --remote --output=./data.sql --no-schema                  # data only
```

Limitations:
- **Not supported for virtual tables** (this includes FTS5). Workaround: drop the virtual tables, export, recreate them.
- **A running export blocks other requests** to that database. Schedule it, and avoid on hot production databases at peak.
- Large integers lose precision beyond JavaScript's safe integer range.
- Use the exported `.sql` with `d1 execute --file` to seed a local or new database.

## Foreign keys during migrations and imports

D1 enforces foreign keys always; you cannot turn enforcement off, only defer it to the end of the transaction:

```sql
PRAGMA defer_foreign_keys = on;
-- CREATE TABLE / ALTER TABLE / bulk INSERT statements that are temporarily inconsistent
```

At commit, everything must be consistent or you get `FOREIGN KEY constraint failed`. `ON DELETE CASCADE` still fires while deferred. For table rebuilds (the SQLite "create new, copy, drop old, rename" dance), put the pragma at the top of the migration file.

## Changelog highlights and deprecated things

Newest first, only what changes how you should write code today:

| Date | Change | What to do |
|---|---|---|
| 2025-11-05 | Jurisdictions for data localization at DB creation | Use when residency is a requirement |
| 2025-09-11 | Auto-retry of read-only queries (up to 2 extra tries), `meta.total_attempts` | Still retry idempotent writes yourself |
| 2025-07-01 | Account storage cap on Paid raised to 1 TB; alpha backups gone | Nothing |
| 2025-05-30 | REST API 50-500 ms faster (edge auth) | Nothing |
| 2025-05-02 | `D1:Edit` permission now required for HTTP API writes | Fix API tokens that only had `D1:Read` + another product's Edit |
| 2025-04-10 | Read replication public beta, Sessions API | See `performance-and-scaling.md` |
| 2025-02-19 | `PRAGMA optimize` supported | Run after index/schema changes |
| 2025-02-04 | Read-only roles/tokens can no longer write | Assign correct roles |
| 2025-01-13 | Free-tier limits enforced from 2025-02-10 | Upgrade to Paid to avoid daily-limit errors |
| 2025-01-07 | Worker API latency down 40-60% | Nothing |
| 2024-08-23 | Alpha databases stopped accepting queries | Migrate via the alpha migration guide |
| 2024-07-26 | Fixed `run()` TypeScript typing | Use `@cloudflare/workers-types` >= 4.20240725.0 |
| 2024-06-17 / 2024-04-12 | HTTP API returns 429 for overload, 400 for invalid SQL (not 500) | Handle in REST clients |
| 2024-04-01 | D1 generally available; 10 GB per database on Paid; export as SQL | Nothing |
| 2024-03-12 | `execute`/`migrations apply` default to local (wrangler >= 3.33.0) | Pass `--remote` for production |
| 2024-02-13 | `raw()` returns arrays of arrays; `all()` unchanged (`run()` change was reverted 2024-02-16) | Do not expect objects from `raw()` |
| 2024-01-18 | `LIMIT` on `UPDATE`/`DELETE` supported | Use as a safety net |
| 2023-09-28 / 2023-10-03 | Public beta; up to 50,000 DBs/account | Database-per-tenant is viable |
| 2023-08-19 | `rows_read`/`rows_written` returned per query | Use for cost tuning |
| 2023-07-27 | New storage subsystem default; **Time Travel** (restore to any minute in last 30 days Paid / 7 days Free) | No flags needed; `--experimental-backend` obsolete |
| 2023-06-12 | `Error.cause` deprecated | Read `Error.message` |
| 2023-05-19 | Location hints; experimental backend flag introduced | Flag is historical |

Alpha databases: `wrangler d1 info <DB>` shows `version: alpha` or `beta`. Alpha = legacy and dead for queries; `db.dump()` only works on alpha-era databases. Time Travel needs the new storage backend (`version: beta`, i.e. every modern database).

## Historical blog notes (what is outdated)

The May 2023 blog post "D1: We turned it up to 11" announced the new storage backend and told people to run `wrangler d1 create <name> --experimental-backend`. It said it would become the default "in the coming weeks"; the release notes confirm it became the default on 2023-07-27. So:

- Do not use `--experimental-backend` in new instructions. Plain `wrangler d1 create <name>` gives you the new backend.
- Performance claims in the post (up to 20x faster on the Northwind demo, about 6.8x faster for 1,000-row inserts, 10-11x for 10,000-row batches, about 3.2x faster than a popular serverless Postgres on a 500k-row key-value read) were Cloudflare's own synthetic benchmarks at the time.
- Pricing in the post (read units of 4 KB, write units of 1 KB) was explicitly provisional. Today's billing is by `rows_read` and `rows_written`; use the live pricing page for numbers.
- The Time Travel CLI examples in the post were marked "subject to some minor API changes". Use `wrangler d1 time-travel --help` and the current Time Travel docs. Bookmarks (also used by Sessions API) identify database versions.
- The blog shows Drizzle and Kysely as ORMs with D1 support; both remain common choices. With Drizzle, mind the nested migrations layout above.
