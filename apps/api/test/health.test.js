import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';

test('GET /health reports database UP when the query succeeds', async () => {
  const db = createFakeDb([{ match: 'SELECT 1', rows: [{ '?column?': 1 }] }]);

  const res = await request(createApp({ db })).get('/health');

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'UP');
  assert.deepEqual(res.body.services, { gateway: 'UP', database: 'UP' });
  assert.equal(typeof res.body.uptime, 'number');
  assert.ok(!Number.isNaN(Date.parse(res.body.timestamp)));
});

test('GET /health reports database DOWN when the query fails', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = createFakeDb([{ match: 'SELECT 1', error: new Error('connection refused') }]);

  const res = await request(createApp({ db })).get('/health');

  assert.equal(res.status, 200);
  assert.equal(res.body.services.database, 'DOWN');
});
