import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const validToken = jwt.sign({ sub: 42, username: 'bob' }, process.env.JWT_SECRET);

const futureDate = new Date(Date.now() + 3600 * 1000).toISOString();
const pastDate = new Date(Date.now() - 3600 * 1000).toISOString();

test('POST /api/auctions/:id/bids successfully places a bid', async () => {
  const db = createFakeDb([
    { match: 'BEGIN', rows: [] },
    {
      match: /FOR UPDATE/,
      rows: [
        {
          id: 1,
          currentPrice: 100.0,
          status: 'ACTIVE',
          sellerId: 10,
          endsAt: futureDate,
        },
      ],
    },
    {
      match: /INSERT INTO bids/,
      respond: (sql, params) => ({
        rows: [
          {
            id: 99,
            auctionId: params[0],
            bidderId: params[1],
            amount: params[2],
            createdAt: '2026-03-30T00:00:00Z',
          },
        ],
      }),
    },
    { match: /UPDATE auctions SET current_price/, rows: [] },
    { match: 'COMMIT', rows: [] },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/auctions/1/bids')
    .set('Authorization', `Bearer ${validToken}`)
    .send({ amount: 105.0 });

  assert.equal(res.status, 201);
  assert.deepEqual(res.body, {
    bid: {
      id: 99,
      auctionId: 1,
      bidderId: 42,
      amount: 105,
      createdAt: '2026-03-30T00:00:00Z',
    },
    auction: {
      currentPrice: 105,
    },
  });

  assert.equal(db.released, 1);
  assert.equal(db.callsMatching('BEGIN').length, 1);
  assert.equal(db.callsMatching(/FOR UPDATE/).length, 1);
  assert.equal(db.callsMatching(/INSERT INTO bids/).length, 1);
  assert.equal(db.callsMatching(/UPDATE auctions SET current_price/).length, 1);
  assert.equal(db.callsMatching('COMMIT').length, 1);
});

test('POST /api/auctions/:id/bids returns 401 without auth header', async () => {
  const db = createFakeDb([]);

  const res = await request(createApp({ db }))
    .post('/api/auctions/1/bids')
    .send({ amount: 105.0 });

  assert.equal(res.status, 401);
  assert.equal(db.calls.length, 0);
});

test('POST /api/auctions/:id/bids returns 400 for invalid amount or invalid auction id', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  const res1 = await request(app)
    .post('/api/auctions/1/bids')
    .set('Authorization', `Bearer ${validToken}`)
    .send({ amount: -10 });
  assert.equal(res1.status, 400);

  const res2 = await request(app)
    .post('/api/auctions/abc/bids')
    .set('Authorization', `Bearer ${validToken}`)
    .send({ amount: 100 });
  assert.equal(res2.status, 400);

  assert.equal(db.calls.length, 0);
});

test('POST /api/auctions/:id/bids returns 404 if auction is not found', async () => {
  const db = createFakeDb([
    { match: 'BEGIN', rows: [] },
    { match: /FOR UPDATE/, rows: [] },
    { match: 'ROLLBACK', rows: [] },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/auctions/999/bids')
    .set('Authorization', `Bearer ${validToken}`)
    .send({ amount: 105.0 });

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Auction not found');
  assert.equal(db.released, 1);
  assert.equal(db.callsMatching('BEGIN').length, 1);
  assert.equal(db.callsMatching('ROLLBACK').length, 1);
});

test('POST /api/auctions/:id/bids returns 403 if seller bids on own auction', async () => {
  const sellerToken = jwt.sign({ sub: 10, username: 'seller' }, process.env.JWT_SECRET);

  const db = createFakeDb([
    { match: 'BEGIN', rows: [] },
    {
      match: /FOR UPDATE/,
      rows: [
        {
          id: 1,
          currentPrice: 100.0,
          status: 'ACTIVE',
          sellerId: 10,
          endsAt: futureDate,
        },
      ],
    },
    { match: 'ROLLBACK', rows: [] },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/auctions/1/bids')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ amount: 105.0 });

  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'Sellers cannot bid on their own auctions');
  assert.equal(db.released, 1);
  assert.equal(db.callsMatching('ROLLBACK').length, 1);
});

test('POST /api/auctions/:id/bids returns 409 if auction is CLOSED or expired', async () => {
  const dbClosed = createFakeDb([
    { match: 'BEGIN', rows: [] },
    {
      match: /FOR UPDATE/,
      rows: [
        {
          id: 1,
          currentPrice: 100.0,
          status: 'CLOSED',
          sellerId: 10,
          endsAt: futureDate,
        },
      ],
    },
    { match: 'ROLLBACK', rows: [] },
  ]);

  const resClosed = await request(createApp({ db: dbClosed }))
    .post('/api/auctions/1/bids')
    .set('Authorization', `Bearer ${validToken}`)
    .send({ amount: 105.0 });

  assert.equal(resClosed.status, 409);
  assert.equal(dbClosed.released, 1);
  assert.equal(dbClosed.callsMatching('ROLLBACK').length, 1);

  const dbExpired = createFakeDb([
    { match: 'BEGIN', rows: [] },
    {
      match: /FOR UPDATE/,
      rows: [
        {
          id: 1,
          currentPrice: 100.0,
          status: 'ACTIVE',
          sellerId: 10,
          endsAt: pastDate,
        },
      ],
    },
    { match: 'ROLLBACK', rows: [] },
  ]);

  const resExpired = await request(createApp({ db: dbExpired }))
    .post('/api/auctions/1/bids')
    .set('Authorization', `Bearer ${validToken}`)
    .send({ amount: 105.0 });

  assert.equal(resExpired.status, 409);
  assert.equal(dbExpired.released, 1);
  assert.equal(dbExpired.callsMatching('ROLLBACK').length, 1);
});

test('POST /api/auctions/:id/bids returns 409 if bid amount is below minimum increment', async () => {
  const db = createFakeDb([
    { match: 'BEGIN', rows: [] },
    {
      match: /FOR UPDATE/,
      rows: [
        {
          id: 1,
          currentPrice: 100.0,
          status: 'ACTIVE',
          sellerId: 10,
          endsAt: futureDate,
        },
      ],
    },
    { match: 'ROLLBACK', rows: [] },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/auctions/1/bids')
    .set('Authorization', `Bearer ${validToken}`)
    .send({ amount: 104.99 });

  assert.equal(res.status, 409);
  assert.equal(db.released, 1);
  assert.equal(db.callsMatching('ROLLBACK').length, 1);
});

test('POST /api/auctions/:id/bids returns 500 on database failure and rolls back transaction', async (t) => {
  t.mock.method(console, 'error', () => {});

  const db = createFakeDb([
    { match: 'BEGIN', rows: [] },
    {
      match: /FOR UPDATE/,
      rows: [
        {
          id: 1,
          currentPrice: 100.0,
          status: 'ACTIVE',
          sellerId: 10,
          endsAt: futureDate,
        },
      ],
    },
    { match: /INSERT INTO bids/, error: new Error('DB connection reset') },
    { match: 'ROLLBACK', rows: [] },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/auctions/1/bids')
    .set('Authorization', `Bearer ${validToken}`)
    .send({ amount: 105.0 });

  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'Internal server error' });
  assert.equal(db.released, 1);
  assert.equal(db.callsMatching('ROLLBACK').length, 1);
});
