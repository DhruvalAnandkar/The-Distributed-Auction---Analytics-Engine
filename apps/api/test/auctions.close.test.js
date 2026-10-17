import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';
import { closeExpiredAuctions } from '../src/services/auctionCloser.js';

const ADMIN_TOKEN = 'secret-admin-token-12345';

test('closeExpiredAuctions updates only ACTIVE and expired auctions using SQL params', async () => {
  const fixedNow = new Date('2026-03-30T15:00:00.000Z');

  const db = createFakeDb([
    { match: 'BEGIN', rows: [] },
    {
      match: /UPDATE auctions/,
      rows: [{ id: 10 }, { id: 20 }],
    },
    {
      match: /FROM bids/,
      rows: [
        {
          auctionId: 10,
          winnerId: 5,
          winningAmount: 250.0,
        },
      ],
    },
    { match: 'COMMIT', rows: [] },
  ]);

  const results = await closeExpiredAuctions({ db, now: fixedNow });

  assert.deepEqual(results, [
    {
      auctionId: 10,
      winnerId: 5,
      winningAmount: 250.0,
    },
    {
      auctionId: 20,
      winnerId: null,
      winningAmount: null,
    },
  ]);

  const updateCalls = db.callsMatching(/UPDATE auctions/);
  assert.equal(updateCalls.length, 1);
  assert.deepEqual(updateCalls[0].params, ['ACTIVE', fixedNow]);
  assert.ok(updateCalls[0].text.includes("SET status = 'CLOSED'"));
  assert.ok(updateCalls[0].text.includes('WHERE status = $1 AND ends_at <= $2'));

  assert.equal(db.released, 1);
  assert.equal(db.callsMatching('COMMIT').length, 1);
});

test('closeExpiredAuctions selects the highest bid when multiple bids exist', async () => {
  const fixedNow = new Date('2026-03-30T15:00:00.000Z');

  const db = createFakeDb([
    { match: 'BEGIN', rows: [] },
    {
      match: /UPDATE auctions/,
      rows: [{ id: 1 }],
    },
    {
      match: /FROM bids/,
      rows: [
        { auctionId: 1, winnerId: 2, winningAmount: 120.0 },
        { auctionId: 1, winnerId: 8, winningAmount: 180.0 },
        { auctionId: 1, winnerId: 3, winningAmount: 150.0 },
      ],
    },
    { match: 'COMMIT', rows: [] },
  ]);

  const results = await closeExpiredAuctions({ db, now: fixedNow });

  assert.deepEqual(results, [
    {
      auctionId: 1,
      winnerId: 8,
      winningAmount: 180.0,
    },
  ]);
});

test('closeExpiredAuctions returns empty array when no auctions expire', async () => {
  const db = createFakeDb([
    { match: 'BEGIN', rows: [] },
    { match: /UPDATE auctions/, rows: [] },
    { match: 'COMMIT', rows: [] },
  ]);

  const results = await closeExpiredAuctions({ db });

  assert.deepEqual(results, []);
  assert.equal(db.callsMatching(/FROM bids/).length, 0);
  assert.equal(db.callsMatching('COMMIT').length, 1);
  assert.equal(db.released, 1);
});

test('closeExpiredAuctions rolls back transaction and rethrows when an error occurs', async () => {
  const db = createFakeDb([
    { match: 'BEGIN', rows: [] },
    {
      match: /UPDATE auctions/,
      error: new Error('Database disk full'),
    },
    { match: 'ROLLBACK', rows: [] },
  ]);

  await assert.rejects(
    async () => {
      await closeExpiredAuctions({ db });
    },
    { message: 'Database disk full' }
  );

  assert.equal(db.callsMatching('BEGIN').length, 1);
  assert.equal(db.callsMatching('ROLLBACK').length, 1);
  assert.equal(db.callsMatching('COMMIT').length, 0);
  assert.equal(db.released, 1);
});

test('POST /api/admin/auctions/close-expired returns 401 when X-Admin-Token is missing', async () => {
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  const db = createFakeDb([]);
  const app = createApp({ db });

  const res = await request(app).post('/api/admin/auctions/close-expired');

  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Missing or invalid admin token');
  assert.equal(db.calls.length, 0);
});

test('POST /api/admin/auctions/close-expired returns 401 when token is wrong and uses timingSafeEqual', async (t) => {
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  const spy = t.mock.method(crypto, 'timingSafeEqual');

  const db = createFakeDb([]);
  const app = createApp({ db });

  // Token with matching length but wrong value
  const wrongTokenSameLength = 'x'.repeat(ADMIN_TOKEN.length);
  const resSameLen = await request(app)
    .post('/api/admin/auctions/close-expired')
    .set('X-Admin-Token', wrongTokenSameLength);

  assert.equal(resSameLen.status, 401);
  assert.equal(resSameLen.body.error, 'Invalid admin token');
  assert.ok(spy.mock.calls.length >= 1);

  // Token with different length
  const wrongTokenDiffLength = 'wrong';
  const resDiffLen = await request(app)
    .post('/api/admin/auctions/close-expired')
    .set('X-Admin-Token', wrongTokenDiffLength);

  assert.equal(resDiffLen.status, 401);
  assert.equal(resDiffLen.body.error, 'Invalid admin token');
});

test('POST /api/admin/auctions/close-expired succeeds with valid token and returns 200 with closed auctions', async () => {
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;

  const db = createFakeDb([
    { match: 'BEGIN', rows: [] },
    {
      match: /UPDATE auctions/,
      rows: [{ id: 42 }],
    },
    {
      match: /FROM bids/,
      rows: [{ auctionId: 42, winnerId: 99, winningAmount: 500 }],
    },
    { match: 'COMMIT', rows: [] },
  ]);

  const app = createApp({ db });

  const res = await request(app)
    .post('/api/admin/auctions/close-expired')
    .set('X-Admin-Token', ADMIN_TOKEN);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    auctions: [
      {
        auctionId: 42,
        winnerId: 99,
        winningAmount: 500,
      },
    ],
  });
  assert.equal(db.released, 1);
});

test('POST /api/admin/auctions/close-expired returns 500 when database error occurs', async (t) => {
  t.mock.method(console, 'error', () => {});
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;

  const db = createFakeDb([
    { match: 'BEGIN', rows: [] },
    {
      match: /UPDATE auctions/,
      error: new Error('DB connection dropped'),
    },
    { match: 'ROLLBACK', rows: [] },
  ]);

  const app = createApp({ db });

  const res = await request(app)
    .post('/api/admin/auctions/close-expired')
    .set('X-Admin-Token', ADMIN_TOKEN);

  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'Internal server error' });
  assert.equal(db.released, 1);
});
