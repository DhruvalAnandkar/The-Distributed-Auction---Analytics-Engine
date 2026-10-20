import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const callerId = 42;
const validToken = jwt.sign({ sub: callerId, username: 'alice' }, process.env.JWT_SECRET);

const sampleAuctions = [
  {
    id: 15,
    title: 'Vintage Camera',
    description: 'Mechanical rangefinder',
    startPrice: 200,
    currentPrice: 250,
    status: 'ACTIVE',
    sellerId: callerId,
    endsAt: '2026-12-31T00:00:00Z',
    createdAt: '2026-03-01T00:00:00Z',
  },
  {
    id: 12,
    title: 'Mechanical Keyboard',
    description: 'Custom build',
    startPrice: 150,
    currentPrice: 180,
    status: 'ACTIVE',
    sellerId: callerId,
    endsAt: '2026-12-31T00:00:00Z',
    createdAt: '2026-02-15T00:00:00Z',
  },
  {
    id: 7,
    title: 'Old Painting',
    description: 'Landscape watercolor',
    startPrice: 80,
    currentPrice: 80,
    status: 'CLOSED',
    sellerId: callerId,
    endsAt: '2026-01-01T00:00:00Z',
    createdAt: '2025-12-01T00:00:00Z',
  },
];

test('GET /api/users/me/auctions returns 401 without authorization token', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  const res = await request(app).get('/api/users/me/auctions');

  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Missing or malformed authorization token' });
  assert.equal(db.calls.length, 0);
});

test('GET /api/users/me/auctions returns 401 with malformed or invalid token', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  const resMalformed = await request(app)
    .get('/api/users/me/auctions')
    .set('Authorization', 'Basic 12345');
  assert.equal(resMalformed.status, 401);
  assert.deepEqual(resMalformed.body, { error: 'Missing or malformed authorization token' });

  const resInvalid = await request(app)
    .get('/api/users/me/auctions')
    .set('Authorization', 'Bearer invalid-token');
  assert.equal(resInvalid.status, 401);
  assert.deepEqual(resInvalid.body, { error: 'Invalid or expired token' });

  assert.equal(db.calls.length, 0);
});

test('GET /api/users/me/auctions returns caller auctions with default limit 20 and nextCursor null', async () => {
  const db = createFakeDb([
    {
      match: /FROM auctions/,
      rows: sampleAuctions,
    },
  ]);
  const app = createApp({ db });

  const res = await request(app)
    .get('/api/users/me/auctions')
    .set('Authorization', `Bearer ${validToken}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.auctions.length, 3);
  assert.deepEqual(res.body.auctions, sampleAuctions);
  assert.deepEqual(res.body.pagination, { nextCursor: null });

  const calls = db.callsMatching(/FROM auctions/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].text.includes('seller_id = $1'));
  assert.ok(calls[0].text.includes('ORDER BY id DESC'));
  assert.ok(calls[0].text.includes('LIMIT $2'));
  assert.deepEqual(calls[0].params, [callerId, 21]);
});

test('GET /api/users/me/auctions returns empty array when user has no auctions', async () => {
  const db = createFakeDb([
    {
      match: /FROM auctions/,
      rows: [],
    },
  ]);
  const app = createApp({ db });

  const res = await request(app)
    .get('/api/users/me/auctions')
    .set('Authorization', `Bearer ${validToken}`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    auctions: [],
    pagination: { nextCursor: null },
  });
});

test('GET /api/users/me/auctions performs keyset pagination with cursor and limit', async () => {
  const db = createFakeDb([
    {
      match: /FROM auctions/,
      once: true,
      rows: [sampleAuctions[0], sampleAuctions[1], sampleAuctions[2]],
    },
    {
      match: /FROM auctions/,
      once: true,
      rows: [sampleAuctions[2]],
    },
  ]);
  const app = createApp({ db });

  // Page 1: limit=2
  const resPage1 = await request(app)
    .get('/api/users/me/auctions?limit=2')
    .set('Authorization', `Bearer ${validToken}`);

  assert.equal(resPage1.status, 200);
  assert.equal(resPage1.body.auctions.length, 2);
  assert.deepEqual(resPage1.body.auctions, [sampleAuctions[0], sampleAuctions[1]]);
  assert.deepEqual(resPage1.body.pagination, { nextCursor: 12 });

  const call1 = db.calls[0];
  assert.ok(call1.text.includes('WHERE seller_id = $1'));
  assert.ok(call1.text.includes('ORDER BY id DESC'));
  assert.ok(call1.text.includes('LIMIT $2'));
  assert.deepEqual(call1.params, [callerId, 3]);

  // Page 2: limit=2, cursor=12
  const resPage2 = await request(app)
    .get('/api/users/me/auctions?limit=2&cursor=12')
    .set('Authorization', `Bearer ${validToken}`);

  assert.equal(resPage2.status, 200);
  assert.equal(resPage2.body.auctions.length, 1);
  assert.deepEqual(resPage2.body.auctions, [sampleAuctions[2]]);
  assert.deepEqual(resPage2.body.pagination, { nextCursor: null });

  const call2 = db.calls[1];
  assert.ok(call2.text.includes('WHERE seller_id = $1 AND id < $2'));
  assert.ok(call2.text.includes('LIMIT $3'));
  assert.deepEqual(call2.params, [callerId, 12, 3]);
});

test('GET /api/users/me/auctions filters by status and combines with cursor', async () => {
  const db = createFakeDb([
    {
      match: /FROM auctions/,
      rows: [sampleAuctions[0]],
    },
  ]);
  const app = createApp({ db });

  const res = await request(app)
    .get('/api/users/me/auctions?status=ACTIVE&cursor=20&limit=5')
    .set('Authorization', `Bearer ${validToken}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.auctions.length, 1);
  assert.deepEqual(res.body.pagination, { nextCursor: null });

  const calls = db.callsMatching(/FROM auctions/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].text.includes('WHERE seller_id = $1 AND status = $2 AND id < $3'));
  assert.deepEqual(calls[0].params, [callerId, 'ACTIVE', 20, 6]);
});

test('GET /api/users/me/auctions returns 400 for invalid query parameters', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  const badStatus = await request(app)
    .get('/api/users/me/auctions?status=INVALID_STATUS')
    .set('Authorization', `Bearer ${validToken}`);
  assert.equal(badStatus.status, 400);
  assert.equal(badStatus.body.error, 'Validation failed');
  assert.ok(badStatus.body.details.some((d) => d.field === 'status'));

  const badLimitMin = await request(app)
    .get('/api/users/me/auctions?limit=0')
    .set('Authorization', `Bearer ${validToken}`);
  assert.equal(badLimitMin.status, 400);
  assert.ok(badLimitMin.body.details.some((d) => d.field === 'limit'));

  const badLimitMax = await request(app)
    .get('/api/users/me/auctions?limit=101')
    .set('Authorization', `Bearer ${validToken}`);
  assert.equal(badLimitMax.status, 400);
  assert.ok(badLimitMax.body.details.some((d) => d.field === 'limit'));

  const badLimitString = await request(app)
    .get('/api/users/me/auctions?limit=notanumber')
    .set('Authorization', `Bearer ${validToken}`);
  assert.equal(badLimitString.status, 400);
  assert.ok(badLimitString.body.details.some((d) => d.field === 'limit'));

  const badCursorZero = await request(app)
    .get('/api/users/me/auctions?cursor=0')
    .set('Authorization', `Bearer ${validToken}`);
  assert.equal(badCursorZero.status, 400);
  assert.ok(badCursorZero.body.details.some((d) => d.field === 'cursor'));

  const badCursorNegative = await request(app)
    .get('/api/users/me/auctions?cursor=-10')
    .set('Authorization', `Bearer ${validToken}`);
  assert.equal(badCursorNegative.status, 400);
  assert.ok(badCursorNegative.body.details.some((d) => d.field === 'cursor'));

  assert.equal(db.calls.length, 0);
});

test('GET /api/users/me/auctions returns 500 when database fails', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = createFakeDb([
    {
      match: /FROM auctions/,
      error: new Error('database connection failed'),
    },
  ]);
  const app = createApp({ db });

  const res = await request(app)
    .get('/api/users/me/auctions')
    .set('Authorization', `Bearer ${validToken}`);

  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'Internal server error' });
});
