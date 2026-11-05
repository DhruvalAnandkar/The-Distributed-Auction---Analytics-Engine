import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';
import { hashToken } from '../src/services/tokenService.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const testPassword = 'Password123!';
const testHash = bcrypt.hashSync(testPassword, 10);
const mockUser = {
  id: 10,
  username: 'charlie',
  email: 'charlie@example.com',
  password: testHash,
  created_at: '2026-01-01T00:00:00Z',
};

test('POST /api/users/login returns a refreshToken and stores only its SHA-256 hash in refresh_tokens', async () => {
  let insertedHash = null;
  let insertedFamily = null;

  const db = createFakeDb([
    {
      match: 'SELECT id, username, email, password, created_at FROM users WHERE email',
      rows: [mockUser],
    },
    {
      match: 'INSERT INTO refresh_tokens',
      respond: (sql, params) => {
        insertedHash = params[1];
        insertedFamily = params[2];
        return { rows: [{ id: 1 }] };
      },
    },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/users/login')
    .send({ email: 'charlie@example.com', password: testPassword });

  assert.equal(res.status, 200);
  assert.ok(res.body.token, 'Expected JWT token in login response');
  assert.ok(res.body.refreshToken, 'Expected refreshToken in login response');
  assert.equal(typeof res.body.refreshToken, 'string');
  assert.equal(res.body.user.id, 10);
  assert.equal(res.body.user.username, 'charlie');

  const expectedHash = hashToken(res.body.refreshToken);
  assert.equal(insertedHash, expectedHash, 'Stored token hash must equal SHA-256 of refreshToken');
  assert.notEqual(insertedHash, res.body.refreshToken, 'Raw refreshToken must never be stored in plain text');
  assert.ok(insertedFamily, 'Expected family_id to be stored');
});

test('POST /api/users/token/refresh rotates the token in a FOR UPDATE transaction', async () => {
  const rawRefreshToken = 'initial-refresh-token-12345';
  const tokenHash = hashToken(rawRefreshToken);
  const familyId = crypto.randomUUID();
  const futureExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  let insertedNewHash = null;

  const db = createFakeDb([
    { match: 'BEGIN', rows: [] },
    {
      match: 'FROM refresh_tokens',
      rows: [
        {
          id: 5,
          userId: 10,
          familyId,
          expiresAt: futureExpiry,
          revokedAt: null,
        },
      ],
    },
    {
      match: 'UPDATE refresh_tokens',
      rows: [],
    },
    {
      match: 'INSERT INTO refresh_tokens',
      respond: (sql, params) => {
        insertedNewHash = params[1];
        return { rows: [{ id: 6 }] };
      },
    },
    {
      match: 'SELECT id, username FROM users WHERE id = $1',
      rows: [{ id: 10, username: 'charlie' }],
    },
    { match: 'COMMIT', rows: [] },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/users/token/refresh')
    .send({ refreshToken: rawRefreshToken });

  assert.equal(res.status, 200);
  assert.ok(res.body.token, 'Expected new access token');
  assert.ok(res.body.refreshToken, 'Expected new rotated refresh token');
  assert.notEqual(res.body.refreshToken, rawRefreshToken, 'Rotated refresh token must differ from old token');

  const decoded = jwt.verify(res.body.token, process.env.JWT_SECRET);
  assert.equal(decoded.sub, 10);
  assert.equal(decoded.username, 'charlie');

  assert.equal(db.released, 1, 'Transaction client must be released');
  assert.equal(db.callsMatching('BEGIN').length, 1);
  assert.equal(db.callsMatching('COMMIT').length, 1);
  assert.equal(db.callsMatching('ROLLBACK').length, 0);

  const forUpdateCalls = db.callsMatching('FOR UPDATE');
  assert.equal(forUpdateCalls.length, 1, 'Expected SELECT FOR UPDATE in refresh flow');
  assert.deepEqual(forUpdateCalls[0].params, [tokenHash]);

  const updateCalls = db.callsMatching('UPDATE refresh_tokens');
  assert.equal(updateCalls.length, 1);
  assert.ok(updateCalls[0].text.includes('WHERE id = $1'));
  assert.deepEqual(updateCalls[0].params, [5]);

  assert.equal(insertedNewHash, hashToken(res.body.refreshToken));
});

test('Reuse of a revoked token revokes the whole family and returns 401', async () => {
  const rawRefreshToken = 'revoked-token-stolen';
  const tokenHash = hashToken(rawRefreshToken);
  const familyId = crypto.randomUUID();

  const db = createFakeDb([
    { match: 'BEGIN', rows: [] },
    {
      match: 'FROM refresh_tokens',
      rows: [
        {
          id: 5,
          userId: 10,
          familyId,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          revokedAt: new Date(Date.now() - 10000).toISOString(),
        },
      ],
    },
    {
      match: 'UPDATE refresh_tokens',
      rows: [],
    },
    { match: 'COMMIT', rows: [] },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/users/token/refresh')
    .send({ refreshToken: rawRefreshToken });

  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Revoked refresh token reused; session invalidated');

  const updateCalls = db.callsMatching('UPDATE refresh_tokens');
  assert.equal(updateCalls.length, 1, 'Expected family revocation query');
  assert.ok(updateCalls[0].text.includes('WHERE family_id = $1 AND revoked_at IS NULL'));
  assert.deepEqual(updateCalls[0].params, [familyId]);

  assert.equal(db.callsMatching('COMMIT').length, 1, 'Family invalidation must be committed');
  assert.equal(db.released, 1, 'Client must be released');
});

test('POST /api/users/token/refresh returns 401 for unknown token', async () => {
  const db = createFakeDb([
    { match: 'BEGIN', rows: [] },
    {
      match: 'FROM refresh_tokens',
      rows: [],
    },
    { match: 'ROLLBACK', rows: [] },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/users/token/refresh')
    .send({ refreshToken: 'non-existent-token' });

  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Invalid refresh token');
  assert.equal(db.callsMatching('ROLLBACK').length, 1);
  assert.equal(db.released, 1);
});

test('POST /api/users/token/refresh returns 401 for expired token', async () => {
  const rawRefreshToken = 'expired-token';
  const familyId = crypto.randomUUID();
  const pastExpiry = new Date(Date.now() - 1000).toISOString();

  const db = createFakeDb([
    { match: 'BEGIN', rows: [] },
    {
      match: 'FROM refresh_tokens',
      rows: [
        {
          id: 7,
          userId: 10,
          familyId,
          expiresAt: pastExpiry,
          revokedAt: null,
        },
      ],
    },
    { match: 'ROLLBACK', rows: [] },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/users/token/refresh')
    .send({ refreshToken: rawRefreshToken });

  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Refresh token expired');
  assert.equal(db.callsMatching('ROLLBACK').length, 1);
  assert.equal(db.released, 1);
});

test('POST /api/users/token/refresh returns 400 when refreshToken is missing', async () => {
  const db = createFakeDb([]);

  const res = await request(createApp({ db }))
    .post('/api/users/token/refresh')
    .send({});

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
  assert.equal(db.calls.length, 0);
});

test('POST /api/users/logout revokes the current refresh token', async () => {
  const rawRefreshToken = 'logout-refresh-token';
  const tokenHash = hashToken(rawRefreshToken);

  const db = createFakeDb([
    { match: 'BEGIN', rows: [] },
    {
      match: 'FROM refresh_tokens',
      rows: [
        {
          id: 15,
          revokedAt: null,
        },
      ],
    },
    {
      match: 'UPDATE refresh_tokens',
      rows: [],
    },
    { match: 'COMMIT', rows: [] },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/users/logout')
    .send({ refreshToken: rawRefreshToken });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { message: 'Logged out successfully' });

  assert.equal(db.released, 1, 'Client must be released');
  assert.equal(db.callsMatching('BEGIN').length, 1);
  assert.equal(db.callsMatching('COMMIT').length, 1);

  const forUpdateCalls = db.callsMatching('FOR UPDATE');
  assert.equal(forUpdateCalls.length, 1);
  assert.deepEqual(forUpdateCalls[0].params, [tokenHash]);

  const updateCalls = db.callsMatching('UPDATE refresh_tokens');
  assert.equal(updateCalls.length, 1);
  assert.ok(updateCalls[0].text.includes('WHERE id = $1'));
  assert.deepEqual(updateCalls[0].params, [15]);
});

test('POST /api/users/logout returns 401 for unknown token', async () => {
  const db = createFakeDb([
    { match: 'BEGIN', rows: [] },
    {
      match: 'FROM refresh_tokens',
      rows: [],
    },
    { match: 'ROLLBACK', rows: [] },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/users/logout')
    .send({ refreshToken: 'unknown-token' });

  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Invalid refresh token');
  assert.equal(db.callsMatching('ROLLBACK').length, 1);
  assert.equal(db.released, 1);
});

test('POST /api/users/logout returns 400 when refreshToken is missing', async () => {
  const db = createFakeDb([]);

  const res = await request(createApp({ db }))
    .post('/api/users/logout')
    .send({});

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
  assert.equal(db.calls.length, 0);
});

test('POST /api/users/token/refresh returns 500 and rolls back when database fails', async (t) => {
  t.mock.method(console, 'error', () => {});

  const db = createFakeDb([
    { match: 'BEGIN', rows: [] },
    {
      match: 'FROM refresh_tokens',
      error: new Error('DB connection dropped'),
    },
    { match: 'ROLLBACK', rows: [] },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/users/token/refresh')
    .send({ refreshToken: 'any-token' });

  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'Internal server error' });
  assert.equal(db.callsMatching('ROLLBACK').length, 1);
  assert.equal(db.released, 1);
});
