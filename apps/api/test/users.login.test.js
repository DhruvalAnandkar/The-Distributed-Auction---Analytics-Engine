import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const testPassword = 'CorrectPassword123!';
const testHash = bcrypt.hashSync(testPassword, 10);
const mockUser = {
  id: 42,
  username: 'alice',
  email: 'alice@example.com',
  password: testHash,
  created_at: '2026-01-01T00:00:00Z',
};

test('POST /api/users/login authenticates with correct credentials and returns token and user without password', async () => {
  const db = createFakeDb([
    {
      match: /SELECT .* FROM users WHERE email/,
      rows: [mockUser],
    },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/users/login')
    .send({ email: 'alice@example.com', password: testPassword });

  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  assert.equal(typeof res.body.token, 'string');
  assert.deepEqual(res.body.user, {
    id: 42,
    username: 'alice',
    email: 'alice@example.com',
    created_at: '2026-01-01T00:00:00Z',
  });
  assert.equal(res.body.user.password, undefined);

  const decoded = jwt.verify(res.body.token, process.env.JWT_SECRET);
  assert.equal(decoded.sub, 42);
  assert.equal(decoded.username, 'alice');
  assert.ok(decoded.exp);
  assert.equal(decoded.exp - decoded.iat, 3600);

  const calls = db.callsMatching(/SELECT .* FROM users WHERE email/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, ['alice@example.com']);
});

test('POST /api/users/login returns 401 with generic message for unknown email', async () => {
  const db = createFakeDb([
    {
      match: /SELECT .* FROM users WHERE email/,
      rows: [],
    },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/users/login')
    .send({ email: 'unknown@example.com', password: testPassword });

  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Invalid credentials' });
});

test('POST /api/users/login returns 401 with generic message for wrong password', async () => {
  const db = createFakeDb([
    {
      match: /SELECT .* FROM users WHERE email/,
      rows: [mockUser],
    },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/users/login')
    .send({ email: 'alice@example.com', password: 'WrongPassword999!' });

  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Invalid credentials' });
});

test('POST /api/users/login normalizes email casing', async () => {
  const db = createFakeDb([
    {
      match: /SELECT .* FROM users WHERE email/,
      rows: [mockUser],
    },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/users/login')
    .send({ email: 'ALICE@EXAMPLE.COM', password: testPassword });

  assert.equal(res.status, 200);
  const calls = db.callsMatching(/SELECT .* FROM users WHERE email/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, ['alice@example.com']);
});

test('POST /api/users/login validates request payload and rejects invalid inputs', async () => {
  const db = createFakeDb([]);

  const resInvalidEmail = await request(createApp({ db }))
    .post('/api/users/login')
    .send({ email: 'not-an-email', password: 'pwd' });
  assert.equal(resInvalidEmail.status, 400);
  assert.equal(resInvalidEmail.body.error, 'Validation failed');

  const resMissingPassword = await request(createApp({ db }))
    .post('/api/users/login')
    .send({ email: 'alice@example.com' });
  assert.equal(resMissingPassword.status, 400);
  assert.equal(resMissingPassword.body.error, 'Validation failed');

  assert.equal(db.calls.length, 0);
});

test('POST /api/users/login returns 500 when JWT_SECRET is missing', async (t) => {
  t.mock.method(console, 'error', () => {});
  const originalSecret = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;

  try {
    const db = createFakeDb([
      {
        match: /SELECT .* FROM users WHERE email/,
        rows: [mockUser],
      },
    ]);

    const res = await request(createApp({ db }))
      .post('/api/users/login')
      .send({ email: 'alice@example.com', password: testPassword });

    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Internal server error' });
  } finally {
    process.env.JWT_SECRET = originalSecret;
  }
});

test('POST /api/users/login returns 500 on database error', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = createFakeDb([
    {
      match: /SELECT .* FROM users WHERE email/,
      error: new Error('connection lost'),
    },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/users/login')
    .send({ email: 'alice@example.com', password: testPassword });

  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'Internal server error' });
});
