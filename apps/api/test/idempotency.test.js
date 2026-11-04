import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const userId = 42;
const token = jwt.sign({ sub: userId, username: 'alice' }, process.env.JWT_SECRET);
const futureDate = new Date(Date.now() + 3600 * 1000).toISOString();

const auctionPayload = {
  title: 'Vintage Camera',
  description: 'Nice condition',
  startPrice: 100.0,
  endsAt: futureDate,
};

function computeHash(body) {
  return crypto.createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
}

test('POST /api/auctions replays response with Idempotent-Replayed: true header when same key and same body', async () => {
  const key = 'auction-key-1';
  const hash = computeHash(auctionPayload);

  const storedAuction = {
    id: 10,
    title: 'Vintage Camera',
    description: 'Nice condition',
    startPrice: 100,
    currentPrice: 100,
    status: 'ACTIVE',
    sellerId: userId,
    endsAt: futureDate,
    createdAt: '2026-03-30T00:00:00Z',
  };

  const db = createFakeDb([
    {
      match: /idempotency_keys/,
      rows: [
        {
          requestHash: hash,
          statusCode: 201,
          responseBody: { auction: storedAuction },
          createdAt: new Date().toISOString(),
        },
      ],
    },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/auctions')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key)
    .send(auctionPayload);

  assert.equal(res.status, 201);
  assert.equal(res.headers['idempotent-replayed'], 'true');
  assert.deepEqual(res.body, { auction: storedAuction });
  assert.equal(db.callsMatching(/INSERT INTO auctions/).length, 0);
});

test('POST /api/auctions returns 409 Conflict when same key is used with a different body', async () => {
  const key = 'auction-key-1';
  const storedHash = computeHash(auctionPayload);

  const db = createFakeDb([
    {
      match: /idempotency_keys/,
      rows: [
        {
          requestHash: storedHash,
          statusCode: 201,
          responseBody: { auction: { id: 10 } },
          createdAt: new Date().toISOString(),
        },
      ],
    },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/auctions')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key)
    .send({ ...auctionPayload, title: 'Different Title' });

  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'Idempotency key payload mismatch');
  assert.equal(res.headers['idempotent-replayed'], undefined);
});

test('POST /api/auctions treats key older than 24h as expired and processes request fresh', async () => {
  const key = 'auction-key-expired';
  const hash = computeHash(auctionPayload);
  const expiredDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

  const db = createFakeDb([
    {
      match: /SELECT .* FROM idempotency_keys/i,
      rows: [
        {
          requestHash: hash,
          statusCode: 201,
          responseBody: { auction: { id: 5 } },
          createdAt: expiredDate,
        },
      ],
    },
    {
      match: /DELETE FROM idempotency_keys/i,
      rows: [],
    },
    {
      match: /INSERT INTO auctions/i,
      respond: () => ({
        rows: [
          {
            id: 99,
            title: auctionPayload.title,
            description: auctionPayload.description,
            startPrice: 100,
            currentPrice: 100,
            status: 'ACTIVE',
            sellerId: userId,
            endsAt: futureDate,
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    },
    {
      match: /INSERT INTO idempotency_keys/i,
      rows: [],
    },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/auctions')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key)
    .send(auctionPayload);

  assert.equal(res.status, 201);
  assert.equal(res.headers['idempotent-replayed'], undefined);
  assert.equal(res.body.auction.id, 99);
  assert.equal(db.callsMatching(/DELETE FROM idempotency_keys/i).length, 1);
  assert.equal(db.callsMatching(/INSERT INTO auctions/i).length, 1);
});

test('POST /api/auctions/:id/bids replays stored response when same key and payload are supplied', async () => {
  const key = 'bid-key-1';
  const bidPayload = { amount: 150.0 };
  const hash = computeHash(bidPayload);

  const storedBidResponse = {
    bid: {
      id: 101,
      auctionId: 1,
      bidderId: userId,
      amount: 150,
      createdAt: '2026-03-30T12:00:00Z',
    },
    auction: {
      currentPrice: 150,
    },
  };

  const db = createFakeDb([
    {
      match: /idempotency_keys/,
      rows: [
        {
          requestHash: hash,
          statusCode: 201,
          responseBody: storedBidResponse,
          createdAt: new Date().toISOString(),
        },
      ],
    },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/auctions/1/bids')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key)
    .send(bidPayload);

  assert.equal(res.status, 201);
  assert.equal(res.headers['idempotent-replayed'], 'true');
  assert.deepEqual(res.body, storedBidResponse);
  assert.equal(db.callsMatching('BEGIN').length, 0);
});

test('POST /api/auctions/:id/bids returns 409 Conflict when same key is used with different amount', async () => {
  const key = 'bid-key-1';
  const storedHash = computeHash({ amount: 150.0 });

  const db = createFakeDb([
    {
      match: /idempotency_keys/,
      rows: [
        {
          requestHash: storedHash,
          statusCode: 201,
          responseBody: { bid: { id: 101 } },
          createdAt: new Date().toISOString(),
        },
      ],
    },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/auctions/1/bids')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key)
    .send({ amount: 200.0 });

  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'Idempotency key payload mismatch');
  assert.equal(res.headers['idempotent-replayed'], undefined);
});

test('Requests without Idempotency-Key header execute normally', async () => {
  const db = createFakeDb([
    {
      match: /INSERT INTO auctions/,
      respond: () => ({
        rows: [
          {
            id: 12,
            title: auctionPayload.title,
            description: auctionPayload.description,
            startPrice: 100,
            currentPrice: 100,
            status: 'ACTIVE',
            sellerId: userId,
            endsAt: futureDate,
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/auctions')
    .set('Authorization', `Bearer ${token}`)
    .send(auctionPayload);

  assert.equal(res.status, 201);
  assert.equal(res.headers['idempotent-replayed'], undefined);
  assert.equal(db.callsMatching(/idempotency_keys/).length, 0);
});
