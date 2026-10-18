import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import { createCors } from '../src/middleware/cors.js';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';

test('createCors: allowed origin receives CORS headers and Vary: Origin', async () => {
  const app = express();
  app.use(createCors({ origins: ['https://example.com', 'http://localhost:3000'] }));
  app.get('/test', (req, res) => res.json({ ok: true }));

  const res = await request(app)
    .get('/test')
    .set('Origin', 'https://example.com');

  assert.equal(res.status, 200);
  assert.equal(res.headers['access-control-allow-origin'], 'https://example.com');
  assert.equal(res.headers['vary'], 'Origin');
  assert.equal(res.headers['access-control-allow-methods'], 'GET,POST,PATCH,DELETE,OPTIONS');
  assert.equal(res.headers['access-control-allow-headers'], 'Content-Type,Authorization');
});

test('createCors: disallowed origin receives no Access-Control-Allow-Origin', async () => {
  const app = express();
  app.use(createCors({ origins: ['https://example.com'] }));
  app.get('/test', (req, res) => res.json({ ok: true }));

  const res = await request(app)
    .get('/test')
    .set('Origin', 'https://malicious.com');

  assert.equal(res.status, 200);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('createCors: missing Origin header receives no Access-Control-Allow-Origin', async () => {
  const app = express();
  app.use(createCors({ origins: ['https://example.com'] }));
  app.get('/test', (req, res) => res.json({ ok: true }));

  const res = await request(app).get('/test');

  assert.equal(res.status, 200);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('createCors: OPTIONS preflight from allowed origin returns 204 with CORS headers', async () => {
  const app = express();
  app.use(createCors({ origins: ['https://example.com'] }));
  app.get('/test', (req, res) => res.json({ ok: true }));

  const res = await request(app)
    .options('/test')
    .set('Origin', 'https://example.com');

  assert.equal(res.status, 204);
  assert.equal(res.headers['access-control-allow-origin'], 'https://example.com');
  assert.equal(res.headers['vary'], 'Origin');
  assert.equal(res.headers['access-control-allow-methods'], 'GET,POST,PATCH,DELETE,OPTIONS');
  assert.equal(res.headers['access-control-allow-headers'], 'Content-Type,Authorization');
});

test('createCors: OPTIONS preflight from disallowed origin falls through without CORS headers', async () => {
  const app = express();
  app.use(createCors({ origins: ['https://example.com'] }));
  app.options('/test', (req, res) => res.status(405).send('Not allowed'));

  const res = await request(app)
    .options('/test')
    .set('Origin', 'https://untrusted.com');

  assert.equal(res.status, 405);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('createCors: origins parsed from comma-separated string parameter', async () => {
  const app = express();
  app.use(createCors({ origins: 'https://site-a.com, https://site-b.com' }));
  app.get('/test', (req, res) => res.json({ ok: true }));

  const resA = await request(app)
    .get('/test')
    .set('Origin', 'https://site-a.com');
  assert.equal(resA.status, 200);
  assert.equal(resA.headers['access-control-allow-origin'], 'https://site-a.com');

  const resB = await request(app)
    .get('/test')
    .set('Origin', 'https://site-b.com');
  assert.equal(resB.status, 200);
  assert.equal(resB.headers['access-control-allow-origin'], 'https://site-b.com');
});

test('createCors: defaults to process.env.CORS_ORIGINS when origins is not passed', async () => {
  const original = process.env.CORS_ORIGINS;
  process.env.CORS_ORIGINS = 'https://env-app.com, http://localhost:5173';

  try {
    const app = express();
    app.use(createCors());
    app.get('/test', (req, res) => res.json({ ok: true }));

    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://env-app.com');

    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], 'https://env-app.com');
    assert.equal(res.headers['vary'], 'Origin');

    const disallowedRes = await request(app)
      .get('/test')
      .set('Origin', 'https://other.com');
    assert.equal(disallowedRes.headers['access-control-allow-origin'], undefined);
  } finally {
    process.env.CORS_ORIGINS = original;
  }
});

test('createCors: never sends wildcard * as Access-Control-Allow-Origin', async () => {
  const app = express();
  app.use(createCors({ origins: ['https://example.com'] }));
  app.get('/test', (req, res) => res.json({ ok: true }));

  const res = await request(app)
    .get('/test')
    .set('Origin', 'https://example.com');

  assert.notEqual(res.headers['access-control-allow-origin'], '*');
  assert.equal(res.headers['access-control-allow-origin'], 'https://example.com');
});

test('createApp integration: corsOrigins injected into application', async () => {
  const db = createFakeDb([{ match: 'SELECT 1', rows: [{ '?column?': 1 }] }]);
  const app = createApp({ db, corsOrigins: ['https://auction-client.org'] });

  // Allowed origin GET
  const resGet = await request(app)
    .get('/health')
    .set('Origin', 'https://auction-client.org');

  assert.equal(resGet.status, 200);
  assert.equal(resGet.headers['access-control-allow-origin'], 'https://auction-client.org');
  assert.equal(resGet.headers['vary'], 'Origin');

  // Allowed origin OPTIONS preflight
  const resOptions = await request(app)
    .options('/api/auctions')
    .set('Origin', 'https://auction-client.org');

  assert.equal(resOptions.status, 204);
  assert.equal(resOptions.headers['access-control-allow-origin'], 'https://auction-client.org');
  assert.equal(resOptions.headers['access-control-allow-methods'], 'GET,POST,PATCH,DELETE,OPTIONS');
  assert.equal(resOptions.headers['access-control-allow-headers'], 'Content-Type,Authorization');

  // Disallowed origin
  const resDisallowed = await request(app)
    .get('/health')
    .set('Origin', 'https://unauthorized.org');

  assert.equal(resDisallowed.status, 200);
  assert.equal(resDisallowed.headers['access-control-allow-origin'], undefined);
});
