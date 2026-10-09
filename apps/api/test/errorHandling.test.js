import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { notFound } from '../src/middleware/notFound.js';
import { AppError } from '../src/utils/AppError.js';

test('errorHandler handles AppError with details', async () => {
  const app = express();
  app.get('/error', (req, res, next) => {
    next(new AppError(409, 'Conflict occurred', { field: 'email' }));
  });
  app.use(errorHandler);

  const res = await request(app).get('/error');
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'Conflict occurred', details: { field: 'email' } });
});

test('errorHandler handles unexpected errors without leaking message', async (t) => {
  t.mock.method(console, 'error', () => {});
  const app = express();
  app.get('/error', (req, res, next) => {
    next(new Error('Sensitive database connection string leaked!'));
  });
  app.use(errorHandler);

  const res = await request(app).get('/error');
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'Internal server error' });
  assert.ok(!JSON.stringify(res.body).includes('Sensitive'));
});

test('errorHandler handles malformed JSON body', async () => {
  const app = express();
  app.use(express.json());
  app.post('/data', (req, res) => {
    res.status(200).json({ ok: true });
  });
  app.use(errorHandler);

  const res = await request(app)
    .post('/data')
    .set('Content-Type', 'application/json')
    .send('{"invalid-json: }');

  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'Invalid JSON payload' });
});

test('Full App: Unknown routes return 404 Not Found', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  const res = await request(app).get('/api/non-existent-route');
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Not found' });
});

test('Full App: Database failure in register returns 500 without leaking message', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = createFakeDb([{ match: /SELECT id FROM users/, error: new Error('Secret DB error details') }]);
  const app = createApp({ db });

  const res = await request(app)
    .post('/api/users/register')
    .send({ username: 'bob', email: 'bob@example.com', password: 'password123' });

  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'Internal server error' });
  assert.ok(!JSON.stringify(res.body).includes('Secret DB error details'));
});
