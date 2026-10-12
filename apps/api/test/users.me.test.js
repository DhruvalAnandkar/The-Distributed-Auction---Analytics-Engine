import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const mockUser = {
  id: 42,
  username: 'alice',
  email: 'alice@example.com',
  created_at: '2026-01-01T00:00:00Z',
};

test('GET /api/users/me returns 401 when Authorization header is missing', async () => {
  const db = createFakeDb([]);
  const res = await request(createApp({ db })).get('/api/users/me');

  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Missing or malformed authorization token' });
  assert.equal(db.calls.length, 0);
});
test('GET /api/users/me returns 401 when Authorization header is malformed', async () => {
  const db = createFakeDb([]);
  const res = await request(createApp({ db }))
    .get('/api/users/me')
    .set('Authorization', 'Basic 12345');

  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Missing or malformed authorization token' });
  assert.equal(db.calls.length, 0);
});

test('GET /api/users/me returns 401 when token is invalid or wrongly signed', async () => {
  const db = createFakeDb([]);
  const badToken = jwt.sign({ sub: 42, username: 'alice' }, 'wrong-secret');

  const res = await request(createApp({ db }))
    .get('/api/users/me')
    .set('Authorization', `Bearer ${badToken}`);

  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Invalid or expired token' });
  assert.equal(db.calls.length, 0);
});

test('GET /api/users/me returns 401 when token is expired', async () => {
  const db = createFakeDb([]);
  const expiredToken = jwt.sign({ sub: 42, username: 'alice' }, process.env.JWT_SECRET, {
    expiresIn: '-1s',
  });

  const res = await request(createApp({ db }))
    .get('/api/users/me')
    .set('Authorization', `Bearer ${expiredToken}`);

  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Invalid or expired token' });
  assert.equal(db.calls.length, 0);
});

test('GET /api/users/me returns user profile when token is valid and user exists in DB', async () => {
  const db = createFakeDb([
    {
      match: /SELECT .* FROM users WHERE id/,
      rows: [mockUser],
    },
  ]);

  const validToken = jwt.sign({ sub: 42, username: 'alice' }, process.env.JWT_SECRET);

  const res = await request(createApp({ db }))
    .get('/api/users/me')
    .set('Authorization', `Bearer ${validToken}`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { user: mockUser });

  const calls = db.callsMatching(/SELECT .* FROM users WHERE id/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [42]);
});

test('GET /api/users/me returns 404 when user no longer exists in DB', async () => {
  const db = createFakeDb([
    {
      match: /SELECT .* FROM users WHERE id/,
      rows: [],
    },
  ]);

  const validToken = jwt.sign({ sub: 999, username: 'ghost' }, process.env.JWT_SECRET);

  const res = await request(createApp({ db }))
    .get('/api/users/me')
    .set('Authorization', `Bearer ${validToken}`);

  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'User not found' });
});
