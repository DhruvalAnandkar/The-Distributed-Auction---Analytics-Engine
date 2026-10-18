import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

test('Full app: body exceeding default 100kb limit returns 413 with { error: "Payload too large" }', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  // Generate JSON payload larger than 100kb (~110kb)
  const oversizedContent = 'x'.repeat(110 * 1024);

  const res = await request(app)
    .post('/api/users/register')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify({ username: 'alice', email: 'alice@example.com', password: 'Password123!', padding: oversizedContent }));

  assert.equal(res.status, 413);
  assert.deepEqual(res.body, { error: 'Payload too large' });
  assert.equal(db.calls.length, 0);
});

test('Full app: body within default 100kb limit proceeds normally', async () => {
  const db = createFakeDb([
    { match: /SELECT id FROM users/, rows: [] },
    {
      match: /INSERT INTO users/,
      respond: (sql, params) => ({
        rows: [{ id: 1, username: params[0], email: params[1], created_at: '2026-01-01T00:00:00Z' }],
      }),
    },
  ]);
  const app = createApp({ db });

  const normalPayload = {
    username: 'alice',
    email: 'alice@example.com',
    password: 'Password123!',
  };

  const res = await request(app)
    .post('/api/users/register')
    .set('Content-Type', 'application/json')
    .send(normalPayload);

  assert.equal(res.status, 201);
  assert.equal(res.body.user.username, 'alice');
});

test('Full app: respects custom bodyLimit override via createApp', async () => {
  const db = createFakeDb([]);
  // Configure custom limit of 1kb
  const app = createApp({ db, bodyLimit: '1kb' });

  // Payload size of ~2kb exceeds the 1kb custom limit
  const payload = {
    username: 'bob',
    email: 'bob@example.com',
    password: 'Password123!',
    padding: 'y'.repeat(2048),
  };

  const res = await request(app)
    .post('/api/users/register')
    .set('Content-Type', 'application/json')
    .send(payload);

  assert.equal(res.status, 413);
  assert.deepEqual(res.body, { error: 'Payload too large' });
});

test('Full app: malformed JSON still returns 400', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  const res = await request(app)
    .post('/api/users/register')
    .set('Content-Type', 'application/json')
    .send('{"username": "alice", bad_json}');

  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'Invalid JSON payload' });
});

test('errorHandler unit: maps err.type === "entity.too.large" and err.status === 413 correctly', async () => {
  const app = express();

  app.get('/type-error', (req, res, next) => {
    const err = new Error('request entity too large');
    err.type = 'entity.too.large';
    next(err);
  });

  app.get('/status-error', (req, res, next) => {
    const err = new Error('payload too large');
    err.status = 413;
    next(err);
  });

  app.use(errorHandler);

  const resType = await request(app).get('/type-error');
  assert.equal(resType.status, 413);
  assert.deepEqual(resType.body, { error: 'Payload too large' });

  const resStatus = await request(app).get('/status-error');
  assert.equal(resStatus.status, 413);
  assert.deepEqual(resStatus.body, { error: 'Payload too large' });
});
