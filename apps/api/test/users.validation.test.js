import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';

test('POST /api/users/register normalizes email to lowercase and succeeds with valid payload', async () => {
  const db = createFakeDb([
    { match: /SELECT id FROM users/, rows: [] },
    {
      match: /INSERT INTO users/,
      respond: (sql, params) => ({
        rows: [{ id: 1, username: params[0], email: params[1], created_at: '2026-01-01T00:00:00Z' }],
      }),
    },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/users/register')
    .send({
      username: 'john_doe',
      email: 'John.Doe@Example.COM',
      password: 'password123',
    });

  assert.equal(res.status, 201);
  assert.equal(res.body.user.email, 'john.doe@example.com');

  const calls = db.calls;
  assert.ok(calls.some((call) => call.params && call.params.includes('john.doe@example.com')));
});

test('POST /api/users/register rejects invalid payload and does not query database', async () => {
  const db = createFakeDb([]);

  const res = await request(createApp({ db }))
    .post('/api/users/register')
    .send({
      username: 'a!',
      email: 'invalid-email',
      password: 'short',
    });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
  assert.ok(Array.isArray(res.body.details));
  assert.ok(res.body.details.length >= 3);
  assert.equal(db.calls.length, 0);
});

test('POST /api/users/register rejects password without numbers', async () => {
  const db = createFakeDb([]);

  const res = await request(createApp({ db }))
    .post('/api/users/register')
    .send({
      username: 'valid_user',
      email: 'valid@example.com',
      password: 'onlyletters',
    });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
  assert.ok(res.body.details.some((d) => d.field === 'password'));
  assert.equal(db.calls.length, 0);
});
