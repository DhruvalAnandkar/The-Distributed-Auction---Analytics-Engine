import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';

const payload = { username: 'alice', email: 'alice@example.com', password: 'S3cure!pass' };

test('POST /api/users/register creates a user and never returns the hash', async () => {
  const db = createFakeDb([
    { match: /SELECT id FROM users/, rows: [] },
    {
      match: /INSERT INTO users/,
      respond: (sql, params) => ({
        rows: [{ id: 1, username: params[0], email: params[1], created_at: '2026-10-08T00:00:00Z' }],
      }),
    },
  ]);

  const res = await request(createApp({ db })).post('/api/users/register').send(payload);

  assert.equal(res.status, 201);
  assert.equal(res.body.user.username, 'alice');
  assert.equal(res.body.user.password, undefined);

  const [insert] = db.callsMatching(/INSERT INTO users/);
  const storedHash = insert.params[2];
  assert.notEqual(storedHash, payload.password);
  assert.ok(await bcrypt.compare(payload.password, storedHash));
});

test('POST /api/users/register rejects a duplicate username or email', async () => {
  const db = createFakeDb([{ match: /SELECT id FROM users/, rows: [{ id: 7 }] }]);

  const res = await request(createApp({ db })).post('/api/users/register').send(payload);

  assert.equal(res.status, 400);
  assert.equal(db.callsMatching(/INSERT INTO users/).length, 0);
});

test('POST /api/users/register returns 500 when the database fails', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = createFakeDb([{ match: /SELECT id FROM users/, error: new Error('db down') }]);

  const res = await request(createApp({ db })).post('/api/users/register').send(payload);

  assert.equal(res.status, 500);
});
