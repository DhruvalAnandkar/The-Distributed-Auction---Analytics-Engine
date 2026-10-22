import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const callerId = 42;
const token = jwt.sign({ sub: callerId, username: 'alice' }, process.env.JWT_SECRET);

const sampleBids = [
  {
    id: 105,
    auctionId: 10,
    bidderId: callerId,
    amount: 350.0,
    createdAt: '2026-03-30T14:00:00Z',
    title: 'Vintage Gold Watch',
    currentPrice: 350.0,
    isWinning: true,
  },
  {
    id: 98,
    auctionId: 8,
    bidderId: callerId,
    amount: 120.0,
    createdAt: '2026-03-30T12:00:00Z',
    title: 'Antique Ceramic Vase',
    currentPrice: 150.0,
    isWinning: false,
  },
  {
    id: 75,
    auctionId: 5,
    bidderId: callerId,
    amount: 50.0,
    createdAt: '2026-03-30T10:00:00Z',
    title: 'Retro Gaming Console',
    currentPrice: 50.0,
    isWinning: true,
  },
];

test('GET /api/users/me/bids returns caller bids newest first with default limit 50 and isWinning flag', async () => {
  const db = createFakeDb([
    {
      match: /FROM bids b/,
      respond: () => ({
        rows: sampleBids,
      }),
    },
  ]);

  const res = await request(createApp({ db }))
    .get('/api/users/me/bids')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    bids: sampleBids,
    pagination: {
      nextCursor: null,
    },
  });

  const calls = db.callsMatching(/FROM bids b/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].text.includes('b.bidder_id = $1'));
  assert.ok(calls[0].text.includes('(b.amount = a.current_price) as "isWinning"'));
  assert.ok(calls[0].text.includes('ORDER BY b.id DESC'));
  assert.ok(calls[0].text.includes('LIMIT $2'));
  assert.deepEqual(calls[0].params, [callerId, 51]);
});

test('GET /api/users/me/bids supports keyset pagination with limit and cursor', async () => {
  const db = createFakeDb([
    {
      match: /FROM bids b/,
      once: true,
      rows: [sampleBids[0], sampleBids[1], sampleBids[2]],
    },
    {
      match: /FROM bids b/,
      once: true,
      rows: [sampleBids[2]],
    },
  ]);

  const app = createApp({ db });

  // Page 1: limit 2
  const page1Res = await request(app)
    .get('/api/users/me/bids?limit=2')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(page1Res.status, 200);
  assert.equal(page1Res.body.bids.length, 2);
  assert.deepEqual(page1Res.body.bids, [sampleBids[0], sampleBids[1]]);
  assert.deepEqual(page1Res.body.pagination, { nextCursor: 98 });

  const call1 = db.calls[0];
  assert.ok(!call1.text.includes('b.id <'));
  assert.deepEqual(call1.params, [callerId, 3]);

  // Page 2: limit 2, cursor 98
  const page2Res = await request(app)
    .get('/api/users/me/bids?limit=2&cursor=98')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(page2Res.status, 200);
  assert.equal(page2Res.body.bids.length, 1);
  assert.deepEqual(page2Res.body.bids, [sampleBids[2]]);
  assert.deepEqual(page2Res.body.pagination, { nextCursor: null });

  const call2 = db.calls[1];
  assert.ok(call2.text.includes('b.id < $2'));
  assert.deepEqual(call2.params, [callerId, 98, 3]);
});

test('GET /api/users/me/bids returns empty list when caller has placed no bids', async () => {
  const db = createFakeDb([
    {
      match: /FROM bids b/,
      rows: [],
    },
  ]);

  const res = await request(createApp({ db }))
    .get('/api/users/me/bids')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    bids: [],
    pagination: {
      nextCursor: null,
    },
  });
});

test('GET /api/users/me/bids returns 401 when token is missing or malformed', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  const noTokenRes = await request(app).get('/api/users/me/bids');
  assert.equal(noTokenRes.status, 401);
  assert.deepEqual(noTokenRes.body, { error: 'Missing or malformed authorization token' });

  const badTokenRes = await request(app)
    .get('/api/users/me/bids')
    .set('Authorization', 'Bearer invalid-token');
  assert.equal(badTokenRes.status, 401);
  assert.deepEqual(badTokenRes.body, { error: 'Invalid or expired token' });

  assert.equal(db.calls.length, 0);
});

test('GET /api/users/me/bids returns 400 for invalid query parameters', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  // Limit min boundary
  const resLimitZero = await request(app)
    .get('/api/users/me/bids?limit=0')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(resLimitZero.status, 400);
  assert.ok(resLimitZero.body.details.some((d) => d.field === 'limit'));

  // Limit max boundary
  const resLimitExcess = await request(app)
    .get('/api/users/me/bids?limit=101')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(resLimitExcess.status, 400);
  assert.ok(resLimitExcess.body.details.some((d) => d.field === 'limit'));

  // Limit non-numeric
  const resLimitNan = await request(app)
    .get('/api/users/me/bids?limit=abc')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(resLimitNan.status, 400);
  assert.ok(resLimitNan.body.details.some((d) => d.field === 'limit'));

  // Cursor zero or negative
  const resCursorZero = await request(app)
    .get('/api/users/me/bids?cursor=0')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(resCursorZero.status, 400);
  assert.ok(resCursorZero.body.details.some((d) => d.field === 'cursor'));

  const resCursorNeg = await request(app)
    .get('/api/users/me/bids?cursor=-10')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(resCursorNeg.status, 400);
  assert.ok(resCursorNeg.body.details.some((d) => d.field === 'cursor'));

  // Cursor non-numeric
  const resCursorNan = await request(app)
    .get('/api/users/me/bids?cursor=xyz')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(resCursorNan.status, 400);
  assert.ok(resCursorNan.body.details.some((d) => d.field === 'cursor'));

  assert.equal(db.calls.length, 0);
});

test('GET /api/users/me/bids returns 500 when database fails', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = createFakeDb([
    {
      match: /FROM bids b/,
      error: new Error('Database connection lost'),
    },
  ]);

  const res = await request(createApp({ db }))
    .get('/api/users/me/bids')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'Internal server error' });
});
