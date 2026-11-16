import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';
import { requireRole } from '../src/middleware/requireRole.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const adminToken = jwt.sign({ sub: 1, username: 'admin_user' }, process.env.JWT_SECRET);
const regularToken = jwt.sign({ sub: 2, username: 'regular_user' }, process.env.JWT_SECRET);
const spoofedToken = jwt.sign({ sub: 3, username: 'spoofed_user', role: 'admin' }, process.env.JWT_SECRET);
const ADMIN_TOKEN_SECRET = 'secret-admin-token-xyz';

const sampleUsers = [
  {
    id: 5,
    username: 'eve',
    email: 'eve@example.com',
    role: 'user',
    password: 'hashed-password-never-leak-5',
    createdAt: '2026-03-05T00:00:00.000Z',
  },
  {
    id: 4,
    username: 'dave',
    email: 'dave@example.com',
    role: 'user',
    password: 'hashed-password-never-leak-4',
    createdAt: '2026-03-04T00:00:00.000Z',
  },
  {
    id: 3,
    username: 'carol',
    email: 'carol@example.com',
    role: 'admin',
    password: 'hashed-password-never-leak-3',
    createdAt: '2026-03-03T00:00:00.000Z',
  },
  {
    id: 2,
    username: 'bob',
    email: 'bob@example.com',
    role: 'user',
    password: 'hashed-password-never-leak-2',
    createdAt: '2026-03-02T00:00:00.000Z',
  },
  {
    id: 1,
    username: 'alice',
    email: 'alice@example.com',
    role: 'admin',
    password: 'hashed-password-never-leak-1',
    createdAt: '2026-03-01T00:00:00.000Z',
  },
];

test('requireRole("admin") allows access when database returns role="admin"', async () => {
  const db = createFakeDb([
    {
      match: /SELECT role FROM users WHERE id = \$1/,
      rows: [{ role: 'admin' }],
    },
    {
      match: /ORDER BY id DESC/,
      rows: [{ id: 1, username: 'alice', email: 'alice@example.com', role: 'admin', createdAt: '2026-03-01T00:00:00Z' }],
    },
  ]);
  const app = createApp({ db });

  const res = await request(app)
    .get('/api/admin/users')
    .set('Authorization', `Bearer ${adminToken}`);

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.users));

  const roleCalls = db.callsMatching(/SELECT role FROM users/);
  assert.equal(roleCalls.length, 1);
  assert.deepEqual(roleCalls[0].params, [1]);
});

test('requireRole("admin") rejects with 403 when database returns role="user" even if JWT contains role: admin', async () => {
  const db = createFakeDb([
    {
      match: /SELECT role FROM users WHERE id = \$1/,
      rows: [{ role: 'user' }],
    },
  ]);
  const app = createApp({ db });

  const res = await request(app)
    .get('/api/admin/users')
    .set('Authorization', `Bearer ${spoofedToken}`);

  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'Forbidden' });

  const roleCalls = db.callsMatching(/SELECT role FROM users/);
  assert.equal(roleCalls.length, 1);
  assert.deepEqual(roleCalls[0].params, [3]);
});

test('requireRole("admin") returns 404 when user is not found in database', async () => {
  const db = createFakeDb([
    {
      match: /SELECT role FROM users WHERE id = \$1/,
      rows: [],
    },
  ]);
  const app = createApp({ db });

  const res = await request(app)
    .get('/api/admin/users')
    .set('Authorization', `Bearer ${adminToken}`);

  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'User not found' });
});

test('requireRole middleware returns 401 when req.user is missing', async () => {
  const mw = requireRole('admin', { db: createFakeDb([]) });
  const req = {};
  let caughtError = null;
  await mw(req, {}, (err) => {
    caughtError = err;
  });

  assert.ok(caughtError);
  assert.equal(caughtError.statusCode, 401);
});

test('requireRole returns 500 when database fails', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = createFakeDb([
    {
      match: /SELECT role FROM users WHERE id = \$1/,
      error: new Error('database connection dead'),
    },
  ]);
  const app = createApp({ db });

  const res = await request(app)
    .get('/api/admin/users')
    .set('Authorization', `Bearer ${adminToken}`);

  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'Internal server error' });
});

test('GET /api/admin/users returns 401 without authorization token', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  const res = await request(app).get('/api/admin/users');

  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Missing or malformed authorization token' });
  assert.equal(db.calls.length, 0);
});

test('GET /api/admin/users lists users with keyset pagination and omits password hashes', async () => {
  const db = createFakeDb([
    {
      match: /SELECT role FROM users WHERE id = \$1/,
      rows: [{ role: 'admin' }],
    },
    {
      match: /ORDER BY id DESC/,
      rows: sampleUsers,
    },
  ]);
  const app = createApp({ db });

  const res = await request(app)
    .get('/api/admin/users?limit=3')
    .set('Authorization', `Bearer ${adminToken}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.users.length, 3);
  assert.deepEqual(res.body.pagination, { nextCursor: 3 });

  for (const user of res.body.users) {
    assert.equal(user.password, undefined, 'Password hash must never be returned');
    assert.ok(user.id);
    assert.ok(user.username);
    assert.ok(user.email);
    assert.ok(user.role);
    assert.ok(user.createdAt);
  }

  const roleCalls = db.callsMatching(/SELECT role FROM users/);
  assert.equal(roleCalls.length, 1);

  const listCalls = db.callsMatching(/ORDER BY id DESC/);
  assert.equal(listCalls.length, 1);
  assert.ok(listCalls[0].text.includes('LIMIT $1'));
  assert.deepEqual(listCalls[0].params, [4]);
});

test('GET /api/admin/users keyset pagination with cursor and limit', async () => {
  const db = createFakeDb([
    {
      match: /SELECT role FROM users WHERE id = \$1/,
      rows: [{ role: 'admin' }],
    },
    {
      match: /ORDER BY id DESC/,
      rows: [sampleUsers[3], sampleUsers[4]],
    },
  ]);
  const app = createApp({ db });

  const res = await request(app)
    .get('/api/admin/users?limit=2&cursor=3')
    .set('Authorization', `Bearer ${adminToken}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.users.length, 2);
  assert.deepEqual(res.body.pagination, { nextCursor: null });

  const listCalls = db.callsMatching(/ORDER BY id DESC/);
  assert.equal(listCalls.length, 1);
  assert.ok(listCalls[0].text.includes('WHERE id < $1'));
  assert.ok(listCalls[0].text.includes('LIMIT $2'));
  assert.deepEqual(listCalls[0].params, [3, 3]);
});

test('GET /api/admin/users filters by role', async () => {
  const db = createFakeDb([
    {
      match: /SELECT role FROM users WHERE id = \$1/,
      rows: [{ role: 'admin' }],
    },
    {
      match: /ORDER BY id DESC/,
      rows: [sampleUsers[2], sampleUsers[4]],
    },
  ]);
  const app = createApp({ db });

  const res = await request(app)
    .get('/api/admin/users?role=admin&limit=10')
    .set('Authorization', `Bearer ${adminToken}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.users.length, 2);
  assert.equal(res.body.users[0].role, 'admin');
  assert.equal(res.body.users[1].role, 'admin');

  const listCalls = db.callsMatching(/ORDER BY id DESC/);
  assert.equal(listCalls.length, 1);
  assert.ok(listCalls[0].text.includes('WHERE role = $1'));
  assert.deepEqual(listCalls[0].params, ['admin', 11]);
});

test('GET /api/admin/users rejects invalid query parameters with 400', async () => {
  const db = createFakeDb([
    {
      match: /SELECT role FROM users WHERE id = \$1/,
      rows: [{ role: 'admin' }],
    },
  ]);
  const app = createApp({ db });

  const resBadLimit = await request(app)
    .get('/api/admin/users?limit=0')
    .set('Authorization', `Bearer ${adminToken}`);
  assert.equal(resBadLimit.status, 400);
  assert.equal(resBadLimit.body.error, 'Validation failed');

  const resBadCursor = await request(app)
    .get('/api/admin/users?cursor=-1')
    .set('Authorization', `Bearer ${adminToken}`);
  assert.equal(resBadCursor.status, 400);

  const resBadRole = await request(app)
    .get('/api/admin/users?role=superhero')
    .set('Authorization', `Bearer ${adminToken}`);
  assert.equal(resBadRole.status, 400);
});

test('Existing X-Admin-Token admin endpoint still works as expected', async () => {
  process.env.ADMIN_TOKEN = ADMIN_TOKEN_SECRET;
  const db = createFakeDb([
    { match: 'BEGIN', rows: [] },
    { match: /UPDATE auctions/, rows: [] },
    { match: 'COMMIT', rows: [] },
  ]);
  const app = createApp({ db });

  const res = await request(app)
    .post('/api/admin/auctions/close-expired')
    .set('X-Admin-Token', ADMIN_TOKEN_SECRET);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { auctions: [] });
});
