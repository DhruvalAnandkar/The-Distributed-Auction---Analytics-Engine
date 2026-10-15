import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';

test('GET /api/auctions/:id/bids returns bids newest first with bidder username and highest bid', async () => {
  const db = createFakeDb([
    {
      match: /SELECT .* FROM auctions WHERE id = \$1/,
      rows: [{ id: 1, currentPrice: 150.00 }],
    },
    {
      match: /FROM bids b/,
      rows: [
        {
          id: 2,
          auctionId: 1,
          bidderId: 10,
          amount: 150.00,
          createdAt: '2026-03-30T12:00:00Z',
          bidderUsername: 'charlie',
        },
        {
          id: 1,
          auctionId: 1,
          bidderId: 5,
          amount: 120.00,
          createdAt: '2026-03-30T11:00:00Z',
          bidderUsername: 'alice',
        },
      ],
    },
  ]);

  const res = await request(createApp({ db })).get('/api/auctions/1/bids');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    bids: [
      {
        id: 2,
        auctionId: 1,
        bidderId: 10,
        amount: 150,
        createdAt: '2026-03-30T12:00:00Z',
        bidderUsername: 'charlie',
      },
      {
        id: 1,
        auctionId: 1,
        bidderId: 5,
        amount: 120,
        createdAt: '2026-03-30T11:00:00Z',
        bidderUsername: 'alice',
      },
    ],
    highestBid: 150,
  });

  const calls = db.callsMatching(/FROM bids b/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].text.includes('ORDER BY b.created_at DESC'));
  assert.ok(calls[0].text.includes('LIMIT $2'));
  assert.deepEqual(calls[0].params, [1, 50]); // default limit 50 as coerced number
});

test('GET /api/auctions/:id/bids respects custom limit parameter', async () => {
  const db = createFakeDb([
    {
      match: /SELECT .* FROM auctions WHERE id = \$1/,
      rows: [{ id: 1, currentPrice: 100.00 }],
    },
    {
      match: /FROM bids b/,
      rows: [],
    },
  ]);

  const res = await request(createApp({ db })).get('/api/auctions/1/bids?limit=5');

  assert.equal(res.status, 200);
  const calls = db.callsMatching(/FROM bids b/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [1, 5]);
});

test('GET /api/auctions/:id/bids returns 404 for unknown auction', async () => {
  const db = createFakeDb([
    {
      match: /SELECT .* FROM auctions WHERE id = \$1/,
      rows: [],
    },
  ]);

  const res = await request(createApp({ db })).get('/api/auctions/999/bids');

  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Auction not found' });
});

test('GET /api/auctions/:id/bids returns 400 for invalid auction id or invalid limit', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  const resBadId = await request(app).get('/api/auctions/abc/bids');
  assert.equal(resBadId.status, 400);
  assert.equal(resBadId.body.error, 'Validation failed');

  const resBadLimitMin = await request(app).get('/api/auctions/1/bids?limit=0');
  assert.equal(resBadLimitMin.status, 400);

  const resBadLimitMax = await request(app).get('/api/auctions/1/bids?limit=101');
  assert.equal(resBadLimitMax.status, 400);

  const resBadLimitString = await request(app).get('/api/auctions/1/bids?limit=xyz');
  assert.equal(resBadLimitString.status, 400);

  assert.equal(db.calls.length, 0);
});

test('GET /api/auctions/:id/bids returns 500 on database failure', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = createFakeDb([
    {
      match: /SELECT .* FROM auctions WHERE id = \$1/,
      error: new Error('db down'),
    },
  ]);

  const res = await request(createApp({ db })).get('/api/auctions/1/bids');

  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'Internal server error' });
});
