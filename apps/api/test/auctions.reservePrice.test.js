import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const sellerId = 10;
const bidderId = 42;
const sellerToken = jwt.sign({ sub: sellerId, username: 'seller' }, process.env.JWT_SECRET);
const bidderToken = jwt.sign({ sub: bidderId, username: 'bidder' }, process.env.JWT_SECRET);

const futureDate = new Date(Date.now() + 3600 * 1000).toISOString();

test('POST /api/auctions rejects reservePrice less than startPrice with 400', async () => {
  const db = createFakeDb([]);

  const res = await request(createApp({ db }))
    .post('/api/auctions')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({
      title: 'Luxury Painting',
      startPrice: 100,
      reservePrice: 50,
      endsAt: futureDate,
    });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
  assert.ok(res.body.details.some((d) => d.field === 'reservePrice'));
});

test('POST /api/auctions accepts valid reservePrice >= startPrice and returns reservePrice & reserveMet to seller', async () => {
  const db = createFakeDb([
    {
      match: /INSERT INTO auctions/,
      respond: (sql, params) => ({
        rows: [
          {
            id: 100,
            title: params[0],
            description: params[1],
            startPrice: parseFloat(params[2]),
            reservePrice: parseFloat(params[3]),
            currentPrice: parseFloat(params[2]),
            status: 'ACTIVE',
            sellerId: params[4],
            endsAt: params[5],
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/auctions')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({
      title: 'Rare Coin',
      startPrice: 100,
      reservePrice: 250,
      endsAt: futureDate,
    });

  assert.equal(res.status, 201);
  assert.equal(res.body.auction.id, 100);
  assert.equal(res.body.auction.startPrice, 100);
  assert.equal(res.body.auction.reservePrice, 250);
  assert.equal(res.body.auction.reserveMet, false);
});

test('GET /api/auctions/:id hides reservePrice from non-seller and shows reserveMet', async () => {
  const sampleAuction = {
    id: 1,
    title: 'Vintage Gold Watch',
    description: 'Gold watch',
    startPrice: 100,
    reservePrice: 500,
    currentPrice: 150,
    status: 'ACTIVE',
    sellerId,
    endsAt: futureDate,
    createdAt: new Date().toISOString(),
  };

  const db = createFakeDb([
    {
      match: /WHERE id = \$1/,
      rows: [sampleAuction],
    },
  ]);

  const app = createApp({ db });

  // Non-seller view
  const resNonSeller = await request(app)
    .get('/api/auctions/1')
    .set('Authorization', `Bearer ${bidderToken}`);

  assert.equal(resNonSeller.status, 200);
  assert.equal(resNonSeller.body.auction.reserveMet, false);
  assert.equal(resNonSeller.body.auction.reservePrice, undefined);

  // Unauthenticated view
  const resAnon = await request(app).get('/api/auctions/1');
  assert.equal(resAnon.status, 200);
  assert.equal(resAnon.body.auction.reserveMet, false);
  assert.equal(resAnon.body.auction.reservePrice, undefined);

  // Seller view
  const resSeller = await request(app)
    .get('/api/auctions/1')
    .set('Authorization', `Bearer ${sellerToken}`);

  assert.equal(resSeller.status, 200);
  assert.equal(resSeller.body.auction.reserveMet, false);
  assert.equal(resSeller.body.auction.reservePrice, 500);
});

test('GET /api/auctions returns reserveMet=true when currentPrice reaches reservePrice', async () => {
  const sampleAuction = {
    id: 2,
    title: 'Sports Memorabilia',
    startPrice: 100,
    reservePrice: 200,
    currentPrice: 200,
    status: 'ACTIVE',
    sellerId,
    endsAt: futureDate,
    createdAt: new Date().toISOString(),
  };

  const db = createFakeDb([
    {
      match: /FROM auctions/,
      rows: [sampleAuction],
    },
  ]);

  const res = await request(createApp({ db }))
    .get('/api/auctions')
    .set('Authorization', `Bearer ${bidderToken}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.auctions[0].reserveMet, true);
  assert.equal(res.body.auctions[0].reservePrice, undefined);
});

test('POST /api/auctions/:id/bids includes reserveMet in response when reserve_price exists', async () => {
  const db = createFakeDb([
    { match: 'BEGIN', rows: [] },
    {
      match: /FOR UPDATE/,
      rows: [
        {
          id: 1,
          currentPrice: 100.0,
          reservePrice: 200.0,
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
            id: 99,
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

  const res = await request(createApp({ db }))
    .post('/api/auctions/1/bids')
    .set('Authorization', `Bearer ${bidderToken}`)
    .send({ amount: 150.0 });

  assert.equal(res.status, 201);
  assert.equal(res.body.auction.currentPrice, 150);
  assert.equal(res.body.auction.reserveMet, false);
});

test('Closing expired auction below reserve sets winner null and reserveMet false', async () => {
  const { closeExpiredAuctions } = await import('../src/services/auctionCloser.js');
  const fixedNow = new Date('2026-03-30T15:00:00.000Z');

  const db = createFakeDb([
    { match: 'BEGIN', rows: [] },
    {
      match: /UPDATE auctions/,
      rows: [{ id: 5, reservePrice: 500.0 }],
    },
    {
      match: /FROM bids/,
      rows: [
        {
          auctionId: 5,
          winnerId: bidderId,
          winningAmount: 300.0, // Below 500 reserve
        },
      ],
    },
    { match: 'COMMIT', rows: [] },
  ]);

  const results = await closeExpiredAuctions({ db, now: fixedNow });

  assert.deepEqual(results, [
    {
      auctionId: 5,
      winnerId: null,
      winningAmount: null,
    },
  ]);
});

test('Closing expired auction at or above reserve awards highest bidder', async () => {
  const { closeExpiredAuctions } = await import('../src/services/auctionCloser.js');
  const fixedNow = new Date('2026-03-30T15:00:00.000Z');

  const db = createFakeDb([
    { match: 'BEGIN', rows: [] },
    {
      match: /UPDATE auctions/,
      rows: [{ id: 6, reservePrice: 500.0 }],
    },
    {
      match: /FROM bids/,
      rows: [
        {
          auctionId: 6,
          winnerId: bidderId,
          winningAmount: 500.0, // At reserve
        },
      ],
    },
    { match: 'COMMIT', rows: [] },
  ]);

  const results = await closeExpiredAuctions({ db, now: fixedNow });

  assert.deepEqual(results, [
    {
      auctionId: 6,
      winnerId: bidderId,
      winningAmount: 500.0,
    },
  ]);
});
