# API Conventions

These rules are fed verbatim to the autonomous engineering agent, and they are also the house style for human contributors.

## Runtime
- Node 22, ESM only (`import`/`export`, never `require`). Relative imports always include `.js`.
- Express 5: async handlers may throw, and Express forwards rejections to the error middleware.
- PostgreSQL via `pg`. SQL always uses parameters (`$1, $2`). Never interpolate values into SQL strings.

## Layout (apps/api)
```
src/app.js                 createApp({ db }) — wires middleware and routers. No app.listen here.
src/server.js              process entry: dotenv, createApp(), listen. Keep it tiny.
src/config/db.js           shared pg Pool (default export)
src/routes/<x>Routes.js    export function create<X>Router({ db, ...deps }) -> express.Router
src/controllers/<x>Controller.js  export function create<X>Controller({ db }) -> { handlerA, handlerB }
src/middleware/<name>.js   plain middleware or factories
src/validators/<x>.js      request validation
src/services/<x>.js        domain logic that is not HTTP-specific
src/database/schema.sql    DDL, idempotent (CREATE ... IF NOT EXISTS)
test/<feature>.test.js     tests (node:test + supertest)
test/helpers/fakeDb.js     fake pg pool (read-only for the agent)
```

## Dependency injection
- Controllers and routers receive `db` through a factory. They never import `config/db.js` directly.
- Only `app.js` provides the default (`createApp({ db = pool })`). This lets tests run without Postgres.
- A new router is mounted in `createApp`, e.g. `app.use('/api/auctions', createAuctionRouter({ db }))`.

## Transactions
```js
const client = await db.connect();
try {
  await client.query('BEGIN');
  // SELECT ... FOR UPDATE to lock rows you will modify
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
}
```

## HTTP
- JSON responses. Success shapes are `{ <resource>: {...} }` or `{ <resources>: [...], pagination }`.
- Errors are `{ error: '<human message>' }`, optionally with `details: [...]` for validation errors.
- Status codes:
  - 400 for invalid input
  - 401 for missing or invalid auth
  - 403 for authenticated but not allowed
  - 404 for not found
  - 409 for conflicts or state violations
  - 500 for unexpected errors
- Never return password hashes or raw stack traces.
- Auth (once implemented) uses the `Authorization: Bearer <jwt>` header. The secret comes from `process.env.JWT_SECRET`.

## Tests
- `node:test` + `node:assert/strict` + `supertest`, against `createApp({ db: createFakeDb([...]) })`.
- Cover the happy path AND the failure paths (validation, auth, not-found, DB error).
- Assert on the SQL that was sent when it matters: `db.callsMatching(/INSERT INTO auctions/)`.
- Silence expected error logs with `t.mock.method(console, 'error', () => {})`.
- Tests must not need network, a real database, or timers longer than ~1s.
- In tests, `process.env.JWT_SECRET` is `test-secret` unless the test sets it.

### fakeDb API
```js
import { createFakeDb } from './helpers/fakeDb.js';
const db = createFakeDb([
  { match: /SELECT .* FROM auctions WHERE id/, rows: [{ id: 1, status: 'ACTIVE' }] },
  { match: /INSERT INTO bids/, respond: (sql, params) => ({ rows: [{ id: 9, amount: params[2] }] }) },
  { match: 'BEGIN', rows: [] },
  { match: /UPDATE auctions/, error: new Error('db down'), once: true },
]);
db.calls            // [{ text, params }]
db.callsMatching(re)
db.released         // number of clients released (from db.connect())
```
The first matching handler wins. Unmatched queries return `{ rows: [] }`. `once: true` handlers are consumed, which lets you script a sequence.

## Code style
- Small functions, early returns, `const` by default.
- Use JSDoc on exported functions.
- No new npm packages unless the task lists them in `dependencies`.
