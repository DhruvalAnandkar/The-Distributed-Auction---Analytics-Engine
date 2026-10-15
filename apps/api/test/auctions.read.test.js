import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';

const sampleAuctions = [
  {
    id: 10,
    title: 'Vintage Watch',
    description: 'Gold watch',
    startPrice: 100,
    currentPrice: 150,
    status: 'ACTIVE',
    sellerId: 1,
    endsAt: '2026-12-31T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 9,
    title: 'Antique Vase',
    description: 'Porcelain vase',
    startPrice: 50,
    currentPrice: 50,
    status: 'ACTIVE',
    sellerId: 2,
    endsAt: '2026-12-31T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 8,
    title: 'Classic Painting',
    description: 'Oil on canvas',
    startPrice: 500,
    currentPrice: 700,
    status: 'CLOSED',
    sellerId: 1,
    endsAt: '2026-01-01T00:00:00Z',
    createdAt: '2025-12-01T00:00:00Z',
  },
];

test('GET /api/auctions lists auctions with default limit of 20 and nextCursor null on last page', async () => {
  const db = createFakeDb([
    {
      match: /FROM auctions/,
      respond: () => ({
        rows: sampleAuctions,
      }),
    },
  ]);

  const res = await request(createApp({ db })).get('/api/auctions');

  assert.equal(res.status, 200);
  assert.equal(res.body.auctions.length, 3);
  assert.deepEqual(res.body.auctions, sampleAuctions);
  assert.deepEqual(res.body.pagination, { nextCursor: null });

  const calls = db.callsMatching(/FROM auctions/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].text.includes('ORDER BY id DESC'));
  assert.ok(calls[0].text.includes('LIMIT $1'));
  assert.ok(!calls[0].text.includes('OFFSET'));
  assert.deepEqual(calls[0].params, [21]);
});

test('GET /api/auctions performs keyset pagination with cursor and limit', async () => {
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

  // Page 1
  const resPage1 = await request(app).get('/api/auctions?limit=2');
  assert.equal(resPage1.status, 200);
  assert.equal(resPage1.body.auctions.length, 2);
  assert.deepEqual(resPage1.body.auctions, [sampleAuctions[0], sampleAuctions[1]]);
  assert.deepEqual(resPage1.body.pagination, { nextCursor: 9 });

  const call1 = db.calls[0];
  assert.ok(call1.text.includes('LIMIT $1'));
  assert.ok(!call1.text.includes('WHERE id <'));
  assert.ok(!call1.text.includes('OFFSET'));
  assert.deepEqual(call1.params, [3]);

  // Page 2 with cursor
  const resPage2 = await request(app).get('/api/auctions?limit=2&cursor=9');
  assert.equal(resPage2.status, 200);
  assert.equal(resPage2.body.auctions.length, 1);
  assert.deepEqual(resPage2.body.auctions, [sampleAuctions[2]]);
  assert.deepEqual(resPage2.body.pagination, { nextCursor: null });

  const call2 = db.calls[1];
  assert.ok(call2.text.includes('WHERE id < $1'));
  assert.ok(!call2.text.includes('OFFSET'));
  assert.deepEqual(call2.params, [9, 3]);
});

test('GET /api/auctions filters by status and combines with cursor', async () => {
  const db = createFakeDb([
    {
      match: /FROM auctions/,
      rows: [sampleAuctions[0]],
    },
  ]);

  const res = await request(createApp({ db })).get('/api/auctions?status=ACTIVE&cursor=15&limit=10');

  assert.equal(res.status, 200);
  assert.equal(res.body.auctions.length, 1);
  assert.deepEqual(res.body.pagination, { nextCursor: null });

  const calls = db.callsMatching(/FROM auctions/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].text.includes('WHERE status = $1 AND id < $2'));
  assert.ok(!calls[0].text.includes('OFFSET'));
  assert.deepEqual(calls[0].params, ['ACTIVE', 15, 11]);
});

test('GET /api/auctions rejects invalid query parameters with 400', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  const badStatus = await request(app).get('/api/auctions?status=UNKNOWN');
  assert.equal(badStatus.status, 400);
  assert.equal(badStatus.body.error, 'Validation failed');
  assert.ok(badStatus.body.details.some((d) => d.field === 'status'));

  const badLimitMin = await request(app).get('/api/auctions?limit=0');
  assert.equal(badLimitMin.status, 400);
  assert.ok(badLimitMin.body.details.some((d) => d.field === 'limit'));

  const badLimitMax = await request(app).get('/api/auctions?limit=101');
  assert.equal(badLimitMax.status, 400);
  assert.ok(badLimitMax.body.details.some((d) => d.field === 'limit'));

  const badLimitString = await request(app).get('/api/auctions?limit=abc');
  assert.equal(badLimitString.status, 400);
  assert.ok(badLimitString.body.details.some((d) => d.field === 'limit'));

  const badCursorNeg = await request(app).get('/api/auctions?cursor=-5');
  assert.equal(badCursorNeg.status, 400);
  assert.ok(badCursorNeg.body.details.some((d) => d.field === 'cursor'));

  const badCursorZero = await request(app).get('/api/auctions?cursor=0');
  assert.equal(badCursorZero.status, 400);
  assert.ok(badCursorZero.body.details.some((d) => d.field === 'cursor'));

  const badCursorString = await request(app).get('/api/auctions?cursor=notanumber');
  assert.equal(badCursorString.status, 400);
  assert.ok(badCursorString.body.details.some((d) => d.field === 'cursor'));

  assert.equal(db.calls.length, 0);
});

test('GET /api/auctions/:id returns one auction by id', async () => {
  const db = createFakeDb([
    {
      match: /WHERE id = \$1/,
      rows: [sampleAuctions[0]],
    },
  ]);

  const res = await request(createApp({ db })).get('/api/auctions/10');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { auction: sampleAuctions[0] });

  const calls = db.callsMatching(/WHERE id = \$1/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [10]);
});

test('GET /api/auctions/:id returns 404 when auction is not found', async () => {
  const db = createFakeDb([
    {
      match: /WHERE id = \$1/,
      rows: [],
    },
  ]);

  const res = await request(createApp({ db })).get('/api/auctions/999');

  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Auction not found' });
});

test('GET /api/auctions/:id returns 400 when id is non-numeric or non-positive', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  const resString = await request(app).get('/api/auctions/abc');
  assert.equal(resString.status, 400);
  assert.equal(resString.body.error, 'Validation failed');
  assert.ok(resString.body.details.some((d) => d.field === 'id'));

  const resNegative = await request(app).get('/api/auctions/-1');
  assert.equal(resNegative.status, 400);

  const resZero = await request(app).get('/api/auctions/0');
  assert.equal(resZero.status, 400);

  assert.equal(db.calls.length, 0);
});

test('GET /api/auctions returns 500 when database query fails', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = createFakeDb([
    {
      match: /FROM auctions/,
      error: new Error('connection closed'),
    },
  ]);

  const res = await request(createApp({ db })).get('/api/auctions');

  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'Internal server error' });
});

test('GET /api/auctions/:id returns 500 when database query fails', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = createFakeDb([
    {
      match: /WHERE id = \$1/,
      error: new Error('database timeout'),
    },
  ]);

  const res = await request(createApp({ db })).get('/api/auctions/1');

  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'Internal server error' });
});
