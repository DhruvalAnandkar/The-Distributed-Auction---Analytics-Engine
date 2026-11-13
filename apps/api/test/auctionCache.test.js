import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';
import { createCache } from '../src/services/cache.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const sellerId = 10;
const bidderId = 42;
const sellerToken = jwt.sign({ sub: sellerId, username: 'seller' }, process.env.JWT_SECRET);
const bidderToken = jwt.sign({ sub: bidderId, username: 'bidder' }, process.env.JWT_SECRET);
const ADMIN_TOKEN = 'test-admin-token';

const sampleAuction = {
  id: 1,
  title: 'Cached Watch',
  description: 'Nice watch',
  startPrice: 100,
  currentPrice: 100,
  status: 'ACTIVE',
  sellerId,
  endsAt: new Date(Date.now() + 3600 * 1000).toISOString(),
  createdAt: new Date().toISOString(),
};

test('createCache behaves as an LRU cache on Map with maxEntries and ttlMs', () => {
  let currentTime = 1000;
  const cache = createCache({
    maxEntries: 2,
    ttlMs: 500,
    now: () => currentTime,
  });

  // Basic set & get
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('b'), 2);

  // LRU eviction: accessing 'a' makes 'b' the least recently used
  cache.get('a'); // 'a' is MRU, 'b' is LRU
  cache.set('c', 3); // 'b' evicted
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);

  // TTL expiration
  currentTime = 1600; // 600ms elapsed (> 500ms ttl)
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.has('c'), false);

  // Delete / Invalidate / Clear
  cache.set('d', 4);
  assert.equal(cache.get('d'), 4);
  cache.invalidate('d');
  assert.equal(cache.get('d'), undefined);

  cache.set('e', 5);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.get('e'), undefined);
});

test('GET /api/auctions/:id is a read-through cache hit when warm', async () => {
  const db = createFakeDb([
    {
      match: /created_at as "createdAt"/,
      rows: [sampleAuction],
    },
  ]);

  const cache = createCache();
  const app = createApp({ db, cache });

  // Cold request: queries DB and populates cache
  const resCold = await request(app).get('/api/auctions/1');
  assert.equal(resCold.status, 200);
  assert.equal(resCold.body.auction.title, 'Cached Watch');

  const dbCallsCold = db.callsMatching(/created_at as "createdAt"/).length;
  assert.equal(dbCallsCold, 1);

  // Warm request: served from cache without querying DB
  const resWarm = await request(app).get('/api/auctions/1');
  assert.equal(resWarm.status, 200);
  assert.equal(resWarm.body.auction.title, 'Cached Watch');

  const dbCallsWarm = db.callsMatching(/created_at as "createdAt"/).length;
  assert.equal(dbCallsWarm, 1, 'Warm request should not generate additional DB queries');
});

test('Bid placement invalidates the cached auction', async () => {
  const futureDate = new Date(Date.now() + 3600 * 1000).toISOString();
  const db = createFakeDb([
    {
      match: /created_at as "createdAt"/,
      rows: [sampleAuction],
    },
    { match: 'BEGIN', rows: [] },
    {
      match: /FOR UPDATE/,
      rows: [
        {
          id: 1,
          currentPrice: 100.0,
          status: 'ACTIVE',
          sellerId,
          endsAt: futureDate,
        },
      ],
    },
    {
      match: /INSERT INTO bids/,
      respond: (sql, params) => ({
        rows: [
          {
            id: 10,
            auctionId: params[0],
            bidderId: params[1],
            amount: params[2],
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    },
    { match: /UPDATE auctions SET current_price/, rows: [] },
    { match: 'COMMIT', rows: [] },
  ]);

  const cache = createCache();
  const app = createApp({ db, cache });

  // 1. Warm the cache
  const resGet = await request(app).get('/api/auctions/1');
  assert.equal(resGet.status, 200);
  assert.equal(cache.has(1), true);

  // 2. Place a bid
  const resBid = await request(app)
    .post('/api/auctions/1/bids')
    .set('Authorization', `Bearer ${bidderToken}`)
    .send({ amount: 110.0 });

  assert.equal(resBid.status, 201);

  // 3. Verify cache is invalidated
  assert.equal(cache.has(1), false, 'Cache should be invalidated after placing a bid');
});

test('Auction update invalidates the cached auction', async () => {
  const db = createFakeDb([
    {
      match: /created_at as "createdAt"/,
      rows: [sampleAuction],
    },
    {
      match: /seller_id as "sellerId"/,
      rows: [{ id: 1, sellerId, status: 'ACTIVE' }],
    },
    {
      match: /FROM bids WHERE auction_id/,
      rows: [],
    },
    {
      match: /UPDATE auctions/,
      rows: [{ ...sampleAuction, title: 'Updated Title' }],
    },
  ]);

  const cache = createCache();
  const app = createApp({ db, cache });

  // 1. Warm the cache
  const resGet = await request(app).get('/api/auctions/1');
  assert.equal(resGet.status, 200);
  assert.equal(cache.has(1), true);

  // 2. Update auction
  const resUpdate = await request(app)
    .patch('/api/auctions/1')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ title: 'Updated Title' });

  assert.equal(resUpdate.status, 200);

  // 3. Verify cache is invalidated
  assert.equal(cache.has(1), false, 'Cache should be invalidated after updating an auction');
});

test('Closing expired auctions invalidates cached auctions', async () => {
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;

  const db = createFakeDb([
    {
      match: /created_at as "createdAt"/,
      rows: [sampleAuction],
    },
    { match: 'BEGIN', rows: [] },
    {
      match: /UPDATE auctions/,
      rows: [{ id: 1 }],
    },
    {
      match: /FROM bids/,
      rows: [],
    },
    { match: 'COMMIT', rows: [] },
  ]);

  const cache = createCache();
  const app = createApp({ db, cache });

  // 1. Warm the cache
  const resGet = await request(app).get('/api/auctions/1');
  assert.equal(resGet.status, 200);
  assert.equal(cache.has(1), true);

  // 2. Close expired auctions via admin endpoint
  const resClose = await request(app)
    .post('/api/admin/auctions/close-expired')
    .set('X-Admin-Token', ADMIN_TOKEN);

  assert.equal(resClose.status, 200);

  // 3. Verify cache is invalidated
  assert.equal(cache.has(1), false, 'Cache should be invalidated after closing expired auctions');
});

test('Cache is injectable via createApp({ cache })', async () => {
  const customCache = createCache({ maxEntries: 5 });
  const db = createFakeDb([
    {
      match: /created_at as "createdAt"/,
      rows: [sampleAuction],
    },
  ]);

  const app = createApp({ db, cache: customCache });

  const res = await request(app).get('/api/auctions/1');
  assert.equal(res.status, 200);
  assert.equal(customCache.has(1), true, 'Injected custom cache should hold the cached auction');
});
