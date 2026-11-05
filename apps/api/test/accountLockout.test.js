import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const testPassword = 'CorrectPassword123!';
const testHash = bcrypt.hashSync(testPassword, 10);

const baseUser = {
  id: 42,
  username: 'alice',
  email: 'alice@example.com',
  password: testHash,
  failed_login_count: 0,
  locked_until: null,
  created_at: '2026-01-01T00:00:00Z',
};

test('Account lockout: failed login atomically increments failed_login_count in SQL', async () => {
  let updateCalled = false;

  const db = createFakeDb([
    {
      match: /SELECT .* FROM users WHERE email/,
      rows: [{ ...baseUser, failed_login_count: 0 }],
    },
    {
      match: /UPDATE users\s+SET\s+failed_login_count/i,
      respond: (sql, params) => {
        updateCalled = true;
        assert.ok(sql.includes('failed_login_count + 1'), 'Must increment failed_login_count atomically in SQL');
        assert.ok(sql.includes('locked_until'), 'Must update locked_until in SQL');
        assert.deepEqual(params, [42], 'Must target user id parameter');
        return {
          rows: [{
            failed_login_count: 1,
            locked_until: null,
          }],
        };
      },
    },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/users/login')
    .send({ email: 'alice@example.com', password: 'WrongPassword999!' });

  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Invalid credentials' });
  assert.equal(res.headers['retry-after'], undefined, 'No Retry-After when count is below 5');
  assert.ok(updateCalled, 'Atomic UPDATE must be executed on wrong password');
});

test('Account lockout: 5th failed login locks the account for 15 minutes and returns 401 with Retry-After', async () => {
  const future15Min = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  const db = createFakeDb([
    {
      match: /SELECT .* FROM users WHERE email/,
      rows: [{ ...baseUser, failed_login_count: 4, locked_until: null }],
    },
    {
      match: /UPDATE users\s+SET\s+failed_login_count/i,
      respond: () => ({
        rows: [{
          failed_login_count: 5,
          locked_until: future15Min,
        }],
      }),
    },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/users/login')
    .send({ email: 'alice@example.com', password: 'WrongPassword999!' });

  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Invalid credentials' });
  assert.ok(res.headers['retry-after'], '5th failure must set Retry-After header');
  const retryAfterSec = Number(res.headers['retry-after']);
  assert.ok(retryAfterSec >= 890 && retryAfterSec <= 900, 'Retry-After should be approximately 900 seconds (15 minutes)');
});

test('Account lockout: locked account rejects login attempts with generic 401 and Retry-After (even with correct password)', async () => {
  const lockedUntilDate = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes left

  const db = createFakeDb([
    {
      match: /SELECT .* FROM users WHERE email/,
      rows: [{
        ...baseUser,
        failed_login_count: 5,
        locked_until: lockedUntilDate,
      }],
    },
  ]);

  // Attempt login with correct password while locked
  const res = await request(createApp({ db }))
    .post('/api/users/login')
    .send({ email: 'alice@example.com', password: testPassword });

  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Invalid credentials' });
  assert.ok(res.headers['retry-after'], 'Locked login attempt must include Retry-After');
  const retryAfterSec = Number(res.headers['retry-after']);
  assert.ok(retryAfterSec >= 590 && retryAfterSec <= 600, 'Retry-After should match remaining lockout time');

  // No password update or refresh token insertion should occur
  assert.equal(db.callsMatching(/UPDATE/).length, 0);
  assert.equal(db.callsMatching(/INSERT INTO refresh_tokens/).length, 0);
});

test('Account lockout: successful login resets failed_login_count and locked_until', async () => {
  let resetCalled = false;

  const db = createFakeDb([
    {
      match: /SELECT .* FROM users WHERE email/,
      rows: [{
        ...baseUser,
        failed_login_count: 3,
        locked_until: null,
      }],
    },
    {
      match: /UPDATE users SET failed_login_count = 0/i,
      respond: (sql, params) => {
        resetCalled = true;
        assert.deepEqual(params, [42], 'Must target authenticated user id');
        return { rows: [] };
      },
    },
    {
      match: /INSERT INTO refresh_tokens/,
      rows: [{ id: 1 }],
    },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/users/login')
    .send({ email: 'alice@example.com', password: testPassword });

  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  assert.ok(res.body.refreshToken);
  assert.equal(res.body.user.id, 42);
  assert.equal(res.body.user.failed_login_count, undefined, 'User response must omit failed_login_count');
  assert.equal(res.body.user.locked_until, undefined, 'User response must omit locked_until');
  assert.ok(resetCalled, 'Successful login must execute reset query');
});

test('Account lockout: login succeeds when previous lockout has expired', async () => {
  const pastLockout = new Date(Date.now() - 60 * 1000).toISOString(); // 1 minute in the past

  const db = createFakeDb([
    {
      match: /SELECT .* FROM users WHERE email/,
      rows: [{
        ...baseUser,
        failed_login_count: 5,
        locked_until: pastLockout,
      }],
    },
    {
      match: /UPDATE users SET failed_login_count = 0/i,
      rows: [],
    },
    {
      match: /INSERT INTO refresh_tokens/,
      rows: [{ id: 1 }],
    },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/users/login')
    .send({ email: 'alice@example.com', password: testPassword });

  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  const resetCalls = db.callsMatching(/UPDATE users SET failed_login_count = 0/i);
  assert.equal(resetCalls.length, 1, 'Must reset lockout state upon successful login after expiration');
});

test('Account lockout: failed login for non-existent email returns generic 401 without Retry-After', async () => {
  const db = createFakeDb([
    {
      match: /SELECT .* FROM users WHERE email/,
      rows: [],
    },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/users/login')
    .send({ email: 'nonexistent@example.com', password: testPassword });

  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Invalid credentials' });
  assert.equal(res.headers['retry-after'], undefined);
  assert.equal(db.callsMatching(/UPDATE/).length, 0);
});

test('Account lockout: database error during update returns 500 without leaking error details', async (t) => {
  t.mock.method(console, 'error', () => {});

  const db = createFakeDb([
    {
      match: /SELECT .* FROM users WHERE email/,
      rows: [{ ...baseUser, failed_login_count: 0 }],
    },
    {
      match: /UPDATE users\s+SET\s+failed_login_count/i,
      error: new Error('Database deadlocked'),
    },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/users/login')
    .send({ email: 'alice@example.com', password: 'WrongPassword!' });

  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'Internal server error' });
});
