import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const validToken = jwt.sign({ sub: 42, username: 'alice' }, process.env.JWT_SECRET);

test('PATCH /api/users/me returns 401 without authorization header', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  const res = await request(app)
    .patch('/api/users/me')
    .send({ username: 'newname' });

  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Missing or malformed authorization token' });
  assert.equal(db.calls.length, 0);
});

test('PATCH /api/users/me returns 401 with invalid token', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  const res = await request(app)
    .patch('/api/users/me')
    .set('Authorization', 'Bearer invalid.token.value')
    .send({ username: 'newname' });

  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Invalid or expired token' });
  assert.equal(db.calls.length, 0);
});

test('PATCH /api/users/me returns 400 for empty body or missing fields', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  const res = await request(app)
    .patch('/api/users/me')
    .set('Authorization', `Bearer ${validToken}`)
    .send({});

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
  assert.ok(Array.isArray(res.body.details));
  assert.equal(db.calls.length, 0);
});

test('PATCH /api/users/me returns 400 for invalid username or email format', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  const resBadUser = await request(app)
    .patch('/api/users/me')
    .set('Authorization', `Bearer ${validToken}`)
    .send({ username: 'ab' }); // < 3 chars

  assert.equal(resBadUser.status, 400);
  assert.equal(resBadUser.body.error, 'Validation failed');
  assert.ok(resBadUser.body.details.some((d) => d.field === 'username'));

  const resBadChars = await request(app)
    .patch('/api/users/me')
    .set('Authorization', `Bearer ${validToken}`)
    .send({ username: 'invalid user!' });

  assert.equal(resBadChars.status, 400);
  assert.ok(resBadChars.body.details.some((d) => d.field === 'username'));

  const resBadEmail = await request(app)
    .patch('/api/users/me')
    .set('Authorization', `Bearer ${validToken}`)
    .send({ email: 'not-an-email' });

  assert.equal(resBadEmail.status, 400);
  assert.ok(resBadEmail.body.details.some((d) => d.field === 'email'));

  assert.equal(db.calls.length, 0);
});

test('PATCH /api/users/me returns 409 when username or email is taken by another user', async () => {
  const db = createFakeDb([
    {
      match: /SELECT id FROM users WHERE/,
      rows: [{ id: 99 }],
    },
  ]);

  const app = createApp({ db });

  const res = await request(app)
    .patch('/api/users/me')
    .set('Authorization', `Bearer ${validToken}`)
    .send({ username: 'taken_user' });

  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'Username or email already in use' });
  assert.equal(db.callsMatching(/UPDATE users/).length, 0);
});

test('PATCH /api/users/me updates username successfully with 200 and scopes UPDATE to req.user.id', async () => {
  const db = createFakeDb([
    {
      match: /SELECT id FROM users WHERE/,
      rows: [],
    },
    {
      match: /UPDATE users/,
      respond: (sql, params) => ({
        rows: [
          {
            id: params[1],
            username: params[0],
            email: 'alice@example.com',
            created_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    },
  ]);

  const app = createApp({ db });

  const res = await request(app)
    .patch('/api/users/me')
    .set('Authorization', `Bearer ${validToken}`)
    .send({ username: 'alice_new' });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    user: {
      id: 42,
      username: 'alice_new',
      email: 'alice@example.com',
      created_at: '2026-01-01T00:00:00.000Z',
    },
  });
  assert.equal(res.body.user.password, undefined);

  const conflictCalls = db.callsMatching(/SELECT id FROM users WHERE/);
  assert.equal(conflictCalls.length, 1);
  assert.deepEqual(conflictCalls[0].params, ['alice_new', 42]);
  assert.ok(conflictCalls[0].text.includes('id != $2'));

  const updateCalls = db.callsMatching(/UPDATE users/);
  assert.equal(updateCalls.length, 1);
  assert.deepEqual(updateCalls[0].params, ['alice_new', 42]);
  assert.ok(updateCalls[0].text.includes('WHERE id = $2'));
});

test('PATCH /api/users/me updates email, lowercases email, and never leaks password', async () => {
  const db = createFakeDb([
    {
      match: /SELECT id FROM users WHERE/,
      rows: [],
    },
    {
      match: /UPDATE users/,
      respond: (sql, params) => ({
        rows: [
          {
            id: params[1],
            username: 'alice',
            email: params[0],
            password: '$2a$10$hashedsecretpassword',
            created_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    },
  ]);

  const app = createApp({ db });

  const res = await request(app)
    .patch('/api/users/me')
    .set('Authorization', `Bearer ${validToken}`)
    .send({ email: 'ALICE_NEW@EXAMPLE.COM' });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    user: {
      id: 42,
      username: 'alice',
      email: 'alice_new@example.com',
      created_at: '2026-01-01T00:00:00.000Z',
    },
  });
  assert.equal(res.body.user.password, undefined);

  const updateCalls = db.callsMatching(/UPDATE users/);
  assert.equal(updateCalls.length, 1);
  assert.deepEqual(updateCalls[0].params, ['alice_new@example.com', 42]);
});

test('PATCH /api/users/me updates both username and email simultaneously', async () => {
  const db = createFakeDb([
    {
      match: /SELECT id FROM users WHERE/,
      rows: [],
    },
    {
      match: /UPDATE users/,
      respond: (sql, params) => ({
        rows: [
          {
            id: params[2],
            username: params[0],
            email: params[1],
            created_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    },
  ]);

  const app = createApp({ db });

  const res = await request(app)
    .patch('/api/users/me')
    .set('Authorization', `Bearer ${validToken}`)
    .send({
      username: 'charlie',
      email: 'Charlie@Domain.COM',
    });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    user: {
      id: 42,
      username: 'charlie',
      email: 'charlie@domain.com',
      created_at: '2026-01-01T00:00:00.000Z',
    },
  });

  const conflictCalls = db.callsMatching(/SELECT id FROM users WHERE/);
  assert.equal(conflictCalls.length, 1);
  assert.deepEqual(conflictCalls[0].params, ['charlie', 'charlie@domain.com', 42]);

  const updateCalls = db.callsMatching(/UPDATE users/);
  assert.equal(updateCalls.length, 1);
  assert.deepEqual(updateCalls[0].params, ['charlie', 'charlie@domain.com', 42]);
  assert.ok(updateCalls[0].text.includes('WHERE id = $3'));
});

test('PATCH /api/users/me allows keeping existing username/email without conflict', async () => {
  const db = createFakeDb([
    {
      match: /SELECT id FROM users WHERE/,
      rows: [], // excluded self via id != $userId
    },
    {
      match: /UPDATE users/,
      rows: [
        {
          id: 42,
          username: 'alice',
          email: 'alice@example.com',
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
  ]);

  const app = createApp({ db });

  const res = await request(app)
    .patch('/api/users/me')
    .set('Authorization', `Bearer ${validToken}`)
    .send({ username: 'alice' });

  assert.equal(res.status, 200);
  assert.equal(res.body.user.username, 'alice');
});

test('PATCH /api/users/me returns 409 if unique constraint 23505 is raised', async () => {
  const uniqueErr = new Error('duplicate key value violates unique constraint');
  uniqueErr.code = '23505';

  const db = createFakeDb([
    {
      match: /SELECT id FROM users WHERE/,
      rows: [],
    },
    {
      match: /UPDATE users/,
      error: uniqueErr,
    },
  ]);

  const app = createApp({ db });

  const res = await request(app)
    .patch('/api/users/me')
    .set('Authorization', `Bearer ${validToken}`)
    .send({ username: 'raced_username' });

  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'Username or email already in use' });
});

test('PATCH /api/users/me returns 404 when user is not found in database', async () => {
  const db = createFakeDb([
    {
      match: /SELECT id FROM users WHERE/,
      rows: [],
    },
    {
      match: /UPDATE users/,
      rows: [],
    },
  ]);

  const app = createApp({ db });

  const res = await request(app)
    .patch('/api/users/me')
    .set('Authorization', `Bearer ${validToken}`)
    .send({ username: 'ghost_user' });

  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'User not found' });
});

test('PATCH /api/users/me returns 500 when database fails', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = createFakeDb([
    {
      match: /SELECT id FROM users WHERE/,
      error: new Error('Database connection failed'),
    },
  ]);

  const app = createApp({ db });

  const res = await request(app)
    .patch('/api/users/me')
    .set('Authorization', `Bearer ${validToken}`)
    .send({ username: 'newname' });

  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'Internal server error' });
});
