import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const sellerId = 42;
const nonSellerId = 99;
const sellerToken = jwt.sign({ sub: sellerId, username: 'alice' }, process.env.JWT_SECRET);
const nonSellerToken = jwt.sign({ sub: nonSellerId, username: 'mallory' }, process.env.JWT_SECRET);

const futureDate = new Date(Date.now() + 120 * 1000).toISOString();

test('PATCH /api/auctions/:id successfully updates title and description on an ACTIVE auction without bids', async () => {
  const db = createFakeDb([
    {
      match: /SELECT id, seller_id as "sellerId", status FROM auctions WHERE id = \$1/,
      rows: [{ id: 1, sellerId, status: 'ACTIVE' }],
    },
    {
      match: /SELECT id FROM bids WHERE auction_id = \$1/,
      rows: [],
    },
    {
      match: /UPDATE auctions/,
      respond: (sql, params) => ({
        rows: [
          {
            id: 1,
            title: params[0],
            description: params[1],
            startPrice: 100,
            currentPrice: 100,
            status: 'ACTIVE',
            sellerId,
            endsAt: '2026-12-31T00:00:00Z',
            createdAt: '2026-03-30T00:00:00Z',
          },
        ],
      }),
    },
  ]);

  const res = await request(createApp({ db }))
    .patch('/api/auctions/1')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({
      title: 'Updated Watch Title',
      description: 'Updated watch description',
    });

  assert.equal(res.status, 200);
  assert.ok(res.body.auction);
  assert.equal(res.body.auction.id, 1);
  assert.equal(res.body.auction.title, 'Updated Watch Title');
  assert.equal(res.body.auction.description, 'Updated watch description');
  assert.equal(res.body.auction.sellerId, sellerId);

  const updateCalls = db.callsMatching(/UPDATE auctions/);
  assert.equal(updateCalls.length, 1);
  assert.ok(updateCalls[0].text.includes('WHERE id = $3 AND seller_id = $4'));
  assert.deepEqual(updateCalls[0].params, [
    'Updated Watch Title',
    'Updated watch description',
    1,
    sellerId,
  ]);
});

test('PATCH /api/auctions/:id successfully updates endsAt on a PENDING auction without bids', async () => {
  const db = createFakeDb([
    {
      match: /SELECT id, seller_id as "sellerId", status FROM auctions WHERE id = \$1/,
      rows: [{ id: 2, sellerId, status: 'PENDING' }],
    },
    {
      match: /SELECT id FROM bids WHERE auction_id = \$1/,
      rows: [],
    },
    {
      match: /UPDATE auctions/,
      respond: (sql, params) => ({
        rows: [
          {
            id: 2,
            title: 'Pending Item',
            description: 'Item description',
            startPrice: 50,
            currentPrice: 50,
            status: 'PENDING',
            sellerId,
            endsAt: params[0],
            createdAt: '2026-03-30T00:00:00Z',
          },
        ],
      }),
    },
  ]);

  const res = await request(createApp({ db }))
    .patch('/api/auctions/2')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({
      endsAt: futureDate,
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.auction.endsAt, futureDate);

  const updateCalls = db.callsMatching(/UPDATE auctions/);
  assert.equal(updateCalls.length, 1);
  assert.ok(updateCalls[0].text.includes('WHERE id = $2 AND seller_id = $3'));
  assert.deepEqual(updateCalls[0].params, [futureDate, 2, sellerId]);
});

test('PATCH /api/auctions/:id returns 401 when Authorization header is missing', async () => {
  const db = createFakeDb([]);

  const res = await request(createApp({ db }))
    .patch('/api/auctions/1')
    .send({ title: 'New Title' });

  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Missing or malformed authorization token' });
  assert.equal(db.calls.length, 0);
});

test('PATCH /api/auctions/:id returns 404 for unknown auction', async () => {
  const db = createFakeDb([
    {
      match: /SELECT id, seller_id as "sellerId", status FROM auctions WHERE id = \$1/,
      rows: [],
    },
  ]);

  const res = await request(createApp({ db }))
    .patch('/api/auctions/999')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ title: 'New Title' });

  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Auction not found' });
});

test('PATCH /api/auctions/:id returns 403 for non-seller', async () => {
  const db = createFakeDb([
    {
      match: /SELECT id, seller_id as "sellerId", status FROM auctions WHERE id = \$1/,
      rows: [{ id: 1, sellerId, status: 'ACTIVE' }],
    },
  ]);

  const res = await request(createApp({ db }))
    .patch('/api/auctions/1')
    .set('Authorization', `Bearer ${nonSellerToken}`)
    .send({ title: 'New Title' });

  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'Only the seller can edit this auction' });
  assert.equal(db.callsMatching(/UPDATE/).length, 0);
});

test('PATCH /api/auctions/:id returns 409 if auction status is CLOSED', async () => {
  const db = createFakeDb([
    {
      match: /SELECT id, seller_id as "sellerId", status FROM auctions WHERE id = \$1/,
      rows: [{ id: 1, sellerId, status: 'CLOSED' }],
    },
  ]);

  const res = await request(createApp({ db }))
    .patch('/api/auctions/1')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ title: 'New Title' });

  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'Auction cannot be edited in its current status' });
  assert.equal(db.callsMatching(/UPDATE/).length, 0);
});

test('PATCH /api/auctions/:id returns 409 if the auction has existing bids', async () => {
  const db = createFakeDb([
    {
      match: /SELECT id, seller_id as "sellerId", status FROM auctions WHERE id = \$1/,
      rows: [{ id: 1, sellerId, status: 'ACTIVE' }],
    },
    {
      match: /SELECT id FROM bids WHERE auction_id = \$1/,
      rows: [{ id: 10 }],
    },
  ]);

  const res = await request(createApp({ db }))
    .patch('/api/auctions/1')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ title: 'New Title' });

  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'Cannot edit auction that already has bids' });
  assert.equal(db.callsMatching(/UPDATE/).length, 0);
});

test('PATCH /api/auctions/:id returns 400 for invalid fields or empty body', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  // Empty payload
  const resEmpty = await request(app)
    .patch('/api/auctions/1')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({});
  assert.equal(resEmpty.status, 400);
  assert.equal(resEmpty.body.error, 'Validation failed');

  // Title too short
  const resShortTitle = await request(app)
    .patch('/api/auctions/1')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ title: 'ab' });
  assert.equal(resShortTitle.status, 400);
  assert.equal(resShortTitle.body.error, 'Validation failed');

  // endsAt in the past
  const pastDate = new Date(Date.now() - 60 * 1000).toISOString();
  const resPastEndsAt = await request(app)
    .patch('/api/auctions/1')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ endsAt: pastDate });
  assert.equal(resPastEndsAt.status, 400);
  assert.equal(resPastEndsAt.body.error, 'Validation failed');

  // endsAt less than 1 minute in the future
  const soonDate = new Date(Date.now() + 30 * 1000).toISOString();
  const resSoonEndsAt = await request(app)
    .patch('/api/auctions/1')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ endsAt: soonDate });
  assert.equal(resSoonEndsAt.status, 400);
  assert.equal(resSoonEndsAt.body.error, 'Validation failed');

  // Unrecognized key (e.g. startPrice)
  const resExtraKey = await request(app)
    .patch('/api/auctions/1')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ startPrice: 100 });
  assert.equal(resExtraKey.status, 400);
  assert.equal(resExtraKey.body.error, 'Validation failed');

  // Non-positive or invalid auction id parameter
  const resBadId = await request(app)
    .patch('/api/auctions/abc')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ title: 'Valid Title' });
  assert.equal(resBadId.status, 400);
  assert.equal(resBadId.body.error, 'Validation failed');

  assert.equal(db.calls.length, 0);
});

test('PATCH /api/auctions/:id returns 500 when database fails', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = createFakeDb([
    {
      match: /SELECT id, seller_id as "sellerId", status FROM auctions WHERE id = \$1/,
      error: new Error('Database connection failed'),
    },
  ]);

  const res = await request(createApp({ db }))
    .patch('/api/auctions/1')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ title: 'New Title' });

  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'Internal server error' });
});
