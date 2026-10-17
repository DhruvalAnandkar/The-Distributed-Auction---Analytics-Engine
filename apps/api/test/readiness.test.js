import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';

test('GET /health/ready returns 200 when SELECT 1 succeeds within 1 second and clears the timer', async (t) => {
  const clearTimeoutSpy = t.mock.method(global, 'clearTimeout');
  const db = createFakeDb([{ match: 'SELECT 1', rows: [{ '?column?': 1 }] }]);

  const app = createApp({ db });
  const res = await request(app).get('/health/ready');

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'UP');
  assert.deepEqual(res.body.services, { database: 'UP' });
  assert.equal(db.callsMatching('SELECT 1').length, 1);
  assert.ok(clearTimeoutSpy.mock.calls.length >= 1, 'clearTimeout should be called');
});

test('GET /health/ready returns 503 when SELECT 1 fails and clears the timer', async (t) => {
  const clearTimeoutSpy = t.mock.method(global, 'clearTimeout');
  const db = createFakeDb([{ match: 'SELECT 1', error: new Error('connection refused') }]);

  const app = createApp({ db });
  const res = await request(app).get('/health/ready');

  assert.equal(res.status, 503);
  assert.equal(res.body.status, 'DOWN');
  assert.deepEqual(res.body.services, { database: 'DOWN' });
  assert.equal(res.body.error, 'Database unavailable');
  assert.equal(db.callsMatching('SELECT 1').length, 1);
  assert.ok(clearTimeoutSpy.mock.calls.length >= 1, 'clearTimeout should be called');
});

test('GET /health/ready yields 503 within ~1s when DB query never resolves and leaves no dangling timer', async (t) => {
  const clearTimeoutSpy = t.mock.method(global, 'clearTimeout');
  const db = createFakeDb([
    { 
      match: 'SELECT 1',
      respond: () => new Promise(() => {}), // never resolves
    },
  ]);

  const app = createApp({ db });
  const start = Date.now();
  const res = await request(app).get('/health/ready');
  const duration = Date.now() - start;

  assert.equal(res.status, 503);
  assert.equal(res.body.status, 'DOWN');
  assert.equal(res.body.error, 'Database unavailable');
  assert.deepEqual(res.body.services, { database: 'DOWN' });
  assert.ok(duration >= 900 && duration < 2500, `Expected ~1s duration, got ${duration}ms`);
  assert.ok(clearTimeoutSpy.mock.calls.length >= 1, 'clearTimeout should be called');
});

test('GET /health liveness probe behavior remains unchanged', async (t) => {
  t.mock.method(console, 'error', () => {});
  const dbUp = createFakeDb([{ match: 'SELECT 1', rows: [{ '?column?': 1 }] }]);
  const resUp = await request(createApp({ db: dbUp })).get('/health');
  assert.equal(resUp.status, 200);
  assert.equal(resUp.body.status, 'UP');
  assert.equal(resUp.body.services.database, 'UP');

  const dbDown = createFakeDb([{ match: 'SELECT 1', error: new Error('db down') }]);
  const resDown = await request(createApp({ db: dbDown })).get('/health');
  assert.equal(resDown.status, 200);
  assert.equal(resDown.body.status, 'UP');
  assert.equal(resDown.body.services.database, 'DOWN');
});
