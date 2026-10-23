import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';

const sampleTopAuctions = [
  {
    id: 10,
    title: 'Vintage Gold Watch',
    currentPrice: '350.00',
    bidCount: 42,
    uniqueBidders: 9,
  },
  {
    id: 5,
    title: 'Rare Comic Book',
    currentPrice: '120.00',
    bidCount: 18,
    uniqueBidders: 4,
  },
];

test('GET /api/analytics/top-auctions returns top auctions with default window=7d and limit=10', async () => {
  const db = createFakeDb([
    {
      match: /FROM auctions a/,
      respond: () => ({
        rows: sampleTopAuctions,
      }),
    },
  ]);

  const res = await request(createApp({ db })).get('/api/analytics/top-auctions');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    auctions: [
      {
        id: 10,
        title: 'Vintage Gold Watch',
        bidCount: 42,
        uniqueBidders: 9,
        currentPrice: 350,
      },
      {
        id: 5,
        title: 'Rare Comic Book',
        bidCount: 18,
        uniqueBidders: 4,
        currentPrice: 120,
      },
    ],
  });

  const calls = db.callsMatching(/FROM auctions a/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].text.includes('JOIN bids b ON b.auction_id = a.id'));
  assert.ok(calls[0].text.includes('WHERE b.created_at >= NOW() - $1::interval'));
  assert.ok(calls[0].text.includes('GROUP BY a.id, a.title, a.current_price'));
  assert.ok(calls[0].text.includes('ORDER BY COUNT(b.id) DESC, a.id DESC'));
  assert.ok(calls[0].text.includes('LIMIT $2'));
  assert.deepEqual(calls[0].params, ['7 days', 10]);
});

test('GET /api/analytics/top-auctions maps window=24h and custom limit using whitelisted interval', async () => {
  const db = createFakeDb([
    {
      match: /FROM auctions a/,
      rows: [sampleTopAuctions[0]],
    },
  ]);

  const res = await request(createApp({ db })).get('/api/analytics/top-auctions?window=24h&limit=5');

  assert.equal(res.status, 200);
  assert.equal(res.body.auctions.length, 1);
  assert.equal(res.body.auctions[0].id, 10);

  const calls = db.callsMatching(/FROM auctions a/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, ['24 hours', 5]);
});

test('GET /api/analytics/top-auctions maps window=30d and maximum limit 50', async () => {
  const db = createFakeDb([
    {
      match: /FROM auctions a/,
      rows: sampleTopAuctions,
    },
  ]);

  const res = await request(createApp({ db })).get('/api/analytics/top-auctions?window=30d&limit=50');

  assert.equal(res.status, 200);
  assert.equal(res.body.auctions.length, 2);

  const calls = db.callsMatching(/FROM auctions a/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, ['30 days', 50]);
});

test('GET /api/analytics/top-auctions returns empty array when no bids exist in the window', async () => {
  const db = createFakeDb([
    {
      match: /FROM auctions a/,
      rows: [],
    },
  ]);

  const res = await request(createApp({ db })).get('/api/analytics/top-auctions?window=24h');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { auctions: [] });
});

test('GET /api/analytics/top-auctions rejects invalid window values with 400', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  const resInvalidWindow = await request(app).get('/api/analytics/top-auctions?window=1h');
  assert.equal(resInvalidWindow.status, 400);
  assert.equal(resInvalidWindow.body.error, 'Validation failed');
  assert.ok(resInvalidWindow.body.details.some((d) => d.field === 'window'));

  const resEmptyWindow = await request(app).get('/api/analytics/top-auctions?window=');
  assert.equal(resEmptyWindow.status, 400);
  assert.equal(resEmptyWindow.body.error, 'Validation failed');

  const resArbitrary = await request(app).get('/api/analytics/top-auctions?window=99d');
  assert.equal(resArbitrary.status, 400);

  assert.equal(db.calls.length, 0);
});

test('GET /api/analytics/top-auctions rejects invalid limit values with 400', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  // Below min (0)
  const resLimitZero = await request(app).get('/api/analytics/top-auctions?limit=0');
  assert.equal(resLimitZero.status, 400);
  assert.ok(resLimitZero.body.details.some((d) => d.field === 'limit'));

  // Negative
  const resLimitNeg = await request(app).get('/api/analytics/top-auctions?limit=-5');
  assert.equal(resLimitNeg.status, 400);

  // Above max (51)
  const resLimitOver = await request(app).get('/api/analytics/top-auctions?limit=51');
  assert.equal(resLimitOver.status, 400);
  assert.ok(resLimitOver.body.details.some((d) => d.field === 'limit'));

  // Non-numeric
  const resLimitNan = await request(app).get('/api/analytics/top-auctions?limit=abc');
  assert.equal(resLimitNan.status, 400);

  // Float
  const resLimitFloat = await request(app).get('/api/analytics/top-auctions?limit=10.5');
  assert.equal(resLimitFloat.status, 400);

  assert.equal(db.calls.length, 0);
});

test('GET /api/analytics/top-auctions returns 500 when database fails', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = createFakeDb([
    {
      match: /FROM auctions a/,
      error: new Error('Database connection failed'),
    },
  ]);

  const res = await request(createApp({ db })).get('/api/analytics/top-auctions');

  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'Internal server error' });
});
