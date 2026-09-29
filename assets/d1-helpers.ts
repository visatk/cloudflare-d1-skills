/**
 * Reusable helpers for Cloudflare D1 in a Worker.
 * Types (D1Database, D1PreparedStatement, D1Result, ...) come from @cloudflare/workers-types
 * or from `wrangler types`. Copy what you need; nothing here depends on other files.
 */

/* ------------------------------------------------------------------ */
/* 1. Retry wrapper for transient errors (use for IDEMPOTENT work only) */
/* ------------------------------------------------------------------ */

const RETRYABLE_MESSAGES = [
  "Network connection lost",
  "storage caused object to be reset",
  "reset because its code was updated",
];

export function isRetryableD1Error(err: unknown): boolean {
  const msg = String(err);
  return RETRYABLE_MESSAGES.some((m) => msg.includes(m));
}

/**
 * Exponential backoff with full jitter. D1 already retries read-only queries
 * (SELECT / EXPLAIN / WITH) up to twice; use this mainly for writes that are
 * idempotent by your own business logic (e.g. INSERT ... ON CONFLICT DO NOTHING).
 * If you prefer a library, @cloudflare/actors exports `tryWhile`.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts?: number; baseMs?: number; maxMs?: number } = {},
): Promise<T> {
  const { maxAttempts = 5, baseMs = 50, maxMs = 2000 } = opts;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt >= maxAttempts || !isRetryableD1Error(err)) throw err;
      const cap = Math.min(maxMs, baseMs * 2 ** attempt);
      const delay = Math.random() * cap; // full jitter
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/* ------------------------------------------------------------------ */
/* 2. Session per request (read replication + read-your-writes)        */
/* ------------------------------------------------------------------ */

export const BOOKMARK_HEADER = "x-d1-bookmark";

/**
 * Starts a D1 session that continues from the bookmark the client sent
 * (or starts unconstrained). Use `session.prepare()` / `session.batch()` for
 * every query in the request, then call `attachBookmark` on the response.
 *
 * Pass `freshStart: true` to begin on the primary (e.g. right after login/checkout).
 */
export function sessionFromRequest(
  db: D1Database,
  request: Request,
  opts: { freshStart?: boolean } = {},
): D1DatabaseSession {
  const bookmark = request.headers.get(BOOKMARK_HEADER);
  const constraint = bookmark ?? (opts.freshStart ? "first-primary" : "first-unconstrained");
  return db.withSession(constraint);
}

export function attachBookmark(response: Response, session: D1DatabaseSession): Response {
  const bookmark = session.getBookmark();
  // Responses from fetch() can be immutable; copy before setting headers.
  const out = new Response(response.body, response);
  if (bookmark) out.headers.set(BOOKMARK_HEADER, bookmark);
  return out;
}

/* ------------------------------------------------------------------ */
/* 3. Chunked batch (large write jobs)                                 */
/* ------------------------------------------------------------------ */

/**
 * Runs many statements in several batches. Each batch is atomic, but the
 * chunks are NOT atomic together: make the job resumable/idempotent.
 * Keep chunks modest (hundreds of statements) so each batch finishes well inside
 * the 30 s limit. Also mind the per-invocation query limit (1,000 Paid / 50 Free);
 * for very large jobs, spread chunks across invocations (Queues, cron, or a
 * resumable admin endpoint) instead of one Worker run.
 */
export async function batchInChunks(
  db: D1Database,
  statements: D1PreparedStatement[],
  chunkSize = 500,
): Promise<D1Result[]> {
  const all: D1Result[] = [];
  for (let i = 0; i < statements.length; i += chunkSize) {
    const res = await db.batch(statements.slice(i, i + chunkSize));
    all.push(...res);
  }
  return all;
}

/* ------------------------------------------------------------------ */
/* 4. JSON-based bulk operations (dodge the 100 bound-parameter limit) */
/* ------------------------------------------------------------------ */

/** WHERE id IN (...) with any number of ids, using one bound parameter. */
export function selectByIds(db: D1Database, ids: Array<number | string>) {
  return db
    .prepare("SELECT * FROM users WHERE id IN (SELECT value FROM json_each(?1))")
    .bind(JSON.stringify(ids));
}

/**
 * Bulk insert objects with one bound parameter. Keep the JSON under 2 MB
 * (max string size); split larger sets across calls.
 * Column names are interpolated into SQL, so they MUST come from your code, never from user input.
 */
export function bulkInsert(
  db: D1Database,
  table: string,
  columns: string[],
  rows: Array<Record<string, unknown>>,
): D1PreparedStatement {
  const ident = /^[A-Za-z_][A-Za-z0-9_]*$/;
  if (!ident.test(table) || !columns.every((c) => ident.test(c))) {
    throw new Error("Invalid identifier");
  }
  const cols = columns.map((c) => `"${c}"`).join(", ");
  const exprs = columns.map((c) => `json_extract(value, '$.${c}')`).join(", ");
  return db
    .prepare(`INSERT INTO "${table}" (${cols}) SELECT ${exprs} FROM json_each(?1)`)
    .bind(JSON.stringify(rows));
}

/* ------------------------------------------------------------------ */
/* 5. Cost/latency logging                                             */
/* ------------------------------------------------------------------ */

/** Log the fields that matter for billing and placement. */
export function logMeta(label: string, result: D1Result): void {
  const m = result.meta;
  console.log(
    JSON.stringify({
      label,
      rows_read: m.rows_read,
      rows_written: m.rows_written,
      sql_ms: m.timings?.sql_duration_ms ?? m.duration,
      served_by_region: m.served_by_region,
      served_by_primary: m.served_by_primary,
      attempts: m.total_attempts,
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Example usage                                                       */
/* ------------------------------------------------------------------ */

/*
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const session = sessionFromRequest(env.DB, request);
    const user = await session
      .prepare("SELECT id, email FROM users WHERE id = ?1")
      .bind(42)
      .first();

    await withRetry(() =>
      env.DB.prepare("INSERT INTO audit (msg) VALUES (?1) ON CONFLICT DO NOTHING").bind("seen").run(),
    );

    return attachBookmark(Response.json(user), session);
  },
} satisfies ExportedHandler<Env>;
*/
