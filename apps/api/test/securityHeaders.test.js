import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';
import { securityHeaders } from '../src/middleware/securityHeaders.js';

const EXPECTED_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
};

function assertSecurityHeaders(res) {
  for (const [header, expectedValue] of Object.entries(EXPECTED_HEADERS)) {
    assert.equal(
      res.headers[header],
      expectedValue,
      `Expected header "${header}" to equal "${expectedValue}", got "${res.headers[header]}"`
    );
  }
  assert.equal(res.headers['x-powered-by'], undefined, 'Expected X-Powered-By to be absent');
}

test('Every 200 response carries all required security headers and omits X-Powered-By', async () => {
  const db = createFakeDb([{ match: 'SELECT 1', rows: [{ '?column?': 1 }] }]);
  const app = createApp({ db });

  const res = await request(app).get('/health');

  assert.equal(res.status, 200);
  assertSecurityHeaders(res);
});

test('Every 404 response carries all required security headers and omits X-Powered-By', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  const res = await request(app).get('/non-existent-endpoint');

  assert.equal(res.status, 404);
  assertSecurityHeaders(res);
});

test('Every 400 validation error response carries all required security headers and omits X-Powered-By', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  const res = await request(app)
    .post('/api/users/register')
    .send({ invalid: 'data' });

  assert.equal(res.status, 400);
  assertSecurityHeaders(res);
});

test('Every 500 error response carries all required security headers and omits X-Powered-By', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = createFakeDb([
    {
      match: /SELECT id FROM users/,
      error: new Error('Database down'),
    },
  ]);
  const app = createApp({ db });

  const res = await request(app)
    .post('/api/users/register')
    .send({
      username: 'test_user',
      email: 'test@example.com',
      password: 'Password123!',
    });

  assert.equal(res.status, 500);
  assertSecurityHeaders(res);
});

test('securityHeaders middleware functions standalone on a bare Express app', async () => {
  const app = express();
  app.use(securityHeaders);
  app.get('/bare-test', (req, res) => res.status(200).send('ok'));

  const res = await request(app).get('/bare-test');

  assert.equal(res.status, 200);
  assertSecurityHeaders(res);
});
