import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const validToken = jwt.sign({ sub: 42, username: 'bob' }, process.env.JWT_SECRET);

test('anti-sniping: bid in the last 2 minutes extends ends_at to NOW()+2min inside transaction and returns endsAt', async () => {
  const now = Date.now();
  const endsAtDate = new Date(now + 60 * 1000);
  const originalEndsAtDate = new Date(endsAtDate);

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
          endsAt: endsAtDate.toISOString(),
          originalEndsAt: originalEndsAtDate.toISOString(),
        },
      ],
    },
    {
      match: /INSERT INTO bids/,
      respond: (sql, params) => ({
        rows: [
          {
            id: 101,
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
    .set('Authorization', `Bearer ${validToken}`)
    .send({ amount: 105.0 });

  assert.equal(res.status, 201);
  assert.equal(res.body.auction.currentPrice, 105);
  assert.ok(res.body.auction.endsAt, 'Response must include endsAt');

  const returnedEndsAt = new Date(res.body.auction.endsAt);
  const expectedMin = new Date(now + 115 * 1000);
  const expectedMax = new Date(now + 125 * 1000);
  assert.ok(
    returnedEndsAt >= expectedMin && returnedEndsAt <= expectedMax,
    `endsAt (${res.body.auction.endsAt}) should be approximately 2 minutes from now`
  );

  const updateCalls = db.callsMatching(/UPDATE auctions SET current_price/);
  assert.equal(updateCalls.length, 1);
  assert.ok(updateCalls[0].text.includes('ends_at = $3'));
  assert.ok(updateCalls[0].text.includes('original_ends_at = COALESCE(original_ends_at, $4)'));
});

test('anti-sniping: bid outside final 2 minutes does not change ends_at and does not include endsAt in response', async () => {
  const now = Date.now();
  const endsAtDate = new Date(now + 10 * 60 * 1000);

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
          endsAt: endsAtDate.toISOString(),
          originalEndsAt: endsAtDate.toISOString(),
        },
      ],
    },
    {
      match: /INSERT INTO bids/,
      respond: (sql, params) => ({
        rows: [
          {
            id: 102,
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
    .set('Authorization', `Bearer ${validToken}`)
    .send({ amount: 105.0 });

  assert.equal(res.status, 201);
  assert.deepEqual(res.body.auction, { currentPrice: 105 });

  const updateCalls = db.callsMatching(/UPDATE auctions SET current_price/);
  assert.equal(updateCalls.length, 1);
  assert.ok(!updateCalls[0].text.includes('ends_at ='));
});

test('anti-sniping: extension is capped at 30 minutes past original_ends_at', async () => {
  const now = Date.now();
  const originalEndsAtDate = new Date(now - 29 * 60 * 1000);
  const currentEndsAtDate = new Date(now + 30 * 1000);

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
          endsAt: currentEndsAtDate.toISOString(),
          originalEndsAt: originalEndsAtDate.toISOString(),
        },
      ],
    },
    {
      match: /INSERT INTO bids/,
      respond: (sql, params) => ({
        rows: [
          {
            id: 103,
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
    .set('Authorization', `Bearer ${validToken}`)
    .send({ amount: 105.0 });

  assert.equal(res.status, 201);
  assert.ok(res.body.auction.endsAt);

  const returnedEndsAt = new Date(res.body.auction.endsAt);
  const maxCap = new Date(originalEndsAtDate.getTime() + 30 * 60 * 1000);

  assert.ok(
    Math.abs(returnedEndsAt.getTime() - maxCap.getTime()) < 2000,
    `endsAt (${returnedEndsAt.toISOString()}) should be capped at original_ends_at + 30m (${maxCap.toISOString()})`
  );
});
