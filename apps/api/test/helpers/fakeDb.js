/**
 * @fileoverview In-memory stand-in for a node-postgres Pool, for tests.
 *
 * Usage:
 *   const db = createFakeDb([
 *     { match: /SELECT id FROM users/, rows: [] },
 *     { match: /INSERT INTO users/, rows: [{ id: 1, username: 'a' }] },
 *     { match: /FROM auctions/, error: new Error('boom') },
 *   ]);
 *   const app = createApp({ db });
 *   ...
 *   db.calls          // [{ text, params }] every query, in order (pool + clients)
 *   db.callsMatching(/INSERT/)
 *
 * Each query is answered by the FIRST handler whose `match` (RegExp or substring)
 * matches the SQL text. Handlers can be:
 *   { match, rows }               -> resolves { rows, rowCount }
 *   { match, error }              -> rejects with error
 *   { match, respond(text, params) } -> custom; return { rows } or throw
 *   add `once: true` to use a handler only once (lets you script sequences).
 * Unmatched queries resolve to { rows: [], rowCount: 0 }.
 *
 * `db.connect()` returns a client with `query` and `release` sharing the same
 * handlers and call log, so code using transactions (BEGIN / SELECT ... FOR UPDATE
 * / COMMIT / ROLLBACK) can be tested. `db.released` counts released clients.
 */

export function createFakeDb(handlers = []) {
  const remaining = [...handlers];
  const calls = [];

  const matches = (handler, text) =>
    handler.match instanceof RegExp ? handler.match.test(text) : text.includes(handler.match);

  async function query(text, params = []) {
    const sql = typeof text === 'string' ? text : text.text;
    const values = typeof text === 'string' ? params : text.values || params;
    calls.push({ text: sql, params: values });

    const index = remaining.findIndex((handler) => matches(handler, sql));
    if (index === -1) {
      return { rows: [], rowCount: 0 };
    }

    const handler = remaining[index];
    if (handler.once) {
      remaining.splice(index, 1);
    }

    if (handler.error) {
      throw handler.error;
    }
    if (handler.respond) {
      const result = await handler.respond(sql, values);
      const rows = (result && result.rows) || [];
      return { rowCount: rows.length, ...result, rows };
    }
    const rows = handler.rows || [];
    return { rows, rowCount: rows.length };
  }

  const db = {
    calls,
    released: 0,
    query,
    async connect() {
      return {
        query,
        release() {
          db.released += 1;
        },
      };
    },
    callsMatching(pattern) {
      return calls.filter((call) =>
        pattern instanceof RegExp ? pattern.test(call.text) : call.text.includes(pattern)
      );
    },
    async end() {},
  };

  return db;
}

export default createFakeDb;
