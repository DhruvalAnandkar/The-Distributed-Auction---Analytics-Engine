import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const userId = 42;
const token = jwt.sign({ sub: userId, username: 'alice' }, process.env.JWT_SECRET);

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
    id: 5,
    title: 'Antique Vase',
    description: 'Blue porcelain',
    startPrice: 50,
    currentPrice: 75,
    status: 'ACTIVE',
    sellerId: 2,
    endsAt: '2026-12-31T00:00:00Z',
    createdAt: '2026-01-02T00:00:00Z',
  },
];

test('POST /api/watchlist/:auctionId successfully adds an auction with 201', async () => {
  const db = createFakeDb([
    {
      match: /SELECT id FROM auctions WHERE id = \$1/,
      rows: [{ id: 10 }],
    },
    {
      match: /INSERT INTO watchlist/,
      respond: (sql, params) => ({
        rowCount: 1,
        rows: [{ auction_id: params[1] }],
      }),
    },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/watchlist/10')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 201);
  assert.deepEqual(res.body.watchlist, {
    userId,
    auctionId: 10,
  });

  const selectCalls = db.callsMatching(/SELECT id FROM auctions/);
  assert.equal(selectCalls.length, 1);
  assert.deepEqual(selectCalls[0].params, [10]);

  const insertCalls = db.callsMatching(/INSERT INTO watchlist/);
  assert.equal(insertCalls.length, 1);
  assert.ok(insertCalls[0].text.includes('ON CONFLICT DO NOTHING'));
  assert.deepEqual(insertCalls[0].params, [userId, 10]);
});

test('POST /api/watchlist/:auctionId adding twice returns 200 without duplication', async () => {
  const db = createFakeDb([
    {
      match: /SELECT id FROM auctions WHERE id = \$1/,
      rows: [{ id: 10 }],
    },
    {
      match: /INSERT INTO watchlist/,
      rows: [], // 0 rows returned indicates conflict hit
    },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/watchlist/10')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.watchlist, {
    userId,
    auctionId: 10,
  });
  assert.equal(res.body.message, 'Auction already in watchlist');
});

test('POST /api/watchlist/:auctionId returns 404 when auction does not exist', async () => {
  const db = createFakeDb([
    {
      match: /SELECT id FROM auctions WHERE id = \$1/,
      rows: [],
    },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/watchlist/999')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Auction not found' });
  assert.equal(db.callsMatching(/INSERT INTO watchlist/).length, 0);
});

test('POST /api/watchlist/:auctionId returns 401 without auth token', async () => {
  const db = createFakeDb([]);
  const res = await request(createApp({ db })).post('/api/watchlist/10');

  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Missing or malformed authorization token' });
  assert.equal(db.calls.length, 0);
});

test('POST /api/watchlist/:auctionId returns 400 for non-positive or invalid auctionId', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  const resAlpha = await request(app)
    .post('/api/watchlist/abc')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(resAlpha.status, 400);
  assert.equal(resAlpha.body.error, 'Validation failed');

  const resNeg = await request(app)
    .post('/api/watchlist/-5')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(resNeg.status, 400);

  const resZero = await request(app)
    .post('/api/watchlist/0')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(resZero.status, 400);

  assert.equal(db.calls.length, 0);
});

test('DELETE /api/watchlist/:auctionId returns 204 and scopes query to req.user.id', async () => {
  const db = createFakeDb([
    {
      match: /DELETE FROM watchlist/,
      rows: [],
    },
  ]);

  const res = await request(createApp({ db }))
    .delete('/api/watchlist/10')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 204);

  const deleteCalls = db.callsMatching(/DELETE FROM watchlist/);
  assert.equal(deleteCalls.length, 1);
  assert.ok(deleteCalls[0].text.includes('user_id = $1 AND auction_id = $2'));
  assert.deepEqual(deleteCalls[0].params, [userId, 10]);
});

test('DELETE /api/watchlist/:auctionId returns 401 without auth token', async () => {
  const db = createFakeDb([]);
  const res = await request(createApp({ db })).delete('/api/watchlist/10');

  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Missing or malformed authorization token' });
  assert.equal(db.calls.length, 0);
});

test('DELETE /api/watchlist/:auctionId returns 400 for invalid auctionId', async () => {
  const db = createFakeDb([]);
  const res = await request(createApp({ db }))
    .delete('/api/watchlist/not-a-number')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
  assert.equal(db.calls.length, 0);
});

test('GET /api/watchlist returns auctions watched by the user newest first scoped to req.user.id', async () => {
  const db = createFakeDb([
    {
      match: /FROM watchlist w/,
      rows: sampleAuctions,
    },
  ]);

  const res = await request(createApp({ db }))
    .get('/api/watchlist')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    auctions: sampleAuctions,
  });

  const calls = db.callsMatching(/FROM watchlist w/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].text.includes('WHERE w.user_id = $1'));
  assert.ok(calls[0].text.includes('ORDER BY w.created_at DESC'));
  assert.deepEqual(calls[0].params, [userId]);
});

test('GET /api/watchlist returns empty array when no auctions are watched', async () => {
  const db = createFakeDb([
    {
      match: /FROM watchlist w/,
      rows: [],
    },
  ]);

  const res = await request(createApp({ db }))
    .get('/api/watchlist')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    auctions: [],
  });
});

test('GET /api/watchlist returns 401 without auth token', async () => {
  const db = createFakeDb([]);
  const res = await request(createApp({ db })).get('/api/watchlist');

  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Missing or malformed authorization token' });
  assert.equal(db.calls.length, 0);
});

test('Watchlist endpoints return 500 on database failure', async (t) => {
  t.mock.method(console, 'error', () => {});

  // POST failure
  const postDb = createFakeDb([
    {
      match: /SELECT id FROM auctions/,
      error: new Error('DB connection failure'),
    },
  ]);
  const postRes = await request(createApp({ db: postDb }))
    .post('/api/watchlist/10')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(postRes.status, 500);
  assert.deepEqual(postRes.body, { error: 'Internal server error' });

  // DELETE failure
  const deleteDb = createFakeDb([
    {
      match: /DELETE FROM watchlist/,
      error: new Error('DB connection failure'),
    },
  ]);
  const deleteRes = await request(createApp({ db: deleteDb }))
    .delete('/api/watchlist/10')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(deleteRes.status, 500);
  assert.deepEqual(deleteRes.body, { error: 'Internal server error' });

  // GET failure
  const getDb = createFakeDb([
    {
      match: /FROM watchlist w/,
      error: new Error('DB connection failure'),
    },
  ]);
  const getRes = await request(createApp({ db: getDb }))
    .get('/api/watchlist')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(getRes.status, 500);
  assert.deepEqual(getRes.body, { error: 'Internal server error' });
});
