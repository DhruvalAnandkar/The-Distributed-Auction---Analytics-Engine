import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';
import { claimBatch, markPublished, writeEvent } from '../src/services/outbox.js';
import { closeExpiredAuctions } from '../src/services/auctionCloser.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const bidderToken = jwt.sign({ sub: 42, username: 'bob' }, process.env.JWT_SECRET);
const futureDate = new Date(Date.now() + 3600 * 1000).toISOString();

test('BidPlaced is written in the same transaction as the bid', async () => {
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
    {
      match: /INSERT INTO domain_events/,
      respond: (sql, params) => {
        assert.equal(params[0], 'BidPlaced');
        const payload = JSON.parse(params[1]);
        assert.equal(payload.bidId, 99);
        assert.equal(payload.auctionId, 1);
        assert.equal(payload.bidderId, 42);
        assert.equal(payload.amount, 110);
        return { rows: [{ id: 1 }] };
      },
    },
    { match: /UPDATE auctions SET current_price/, rows: [] },
    { match: 'COMMIT', rows: [] },
  ]);

  const app = createApp({ db });
  const res = await request(app)
    .post('/api/auctions/1/bids')
    .set('Authorization', `Bearer ${bidderToken}`)
    .send({ amount: 110.0 });

  assert.equal(res.status, 201);

  const eventInserts = db.callsMatching(/INSERT INTO domain_events/);
  assert.equal(eventInserts.length, 1);
  assert.equal(db.callsMatching('COMMIT').length, 1);
});

test('AuctionClosed is written in the same transaction as closing', async () => {
  const fixedNow = new Date('2026-03-30T15:00:00.000Z');

  const db = createFakeDb([
    { match: 'BEGIN', rows: [] },
    {
      match: /UPDATE auctions/,
      rows: [{ id: 10 }],
    },
    {
      match: /FROM bids/,
      rows: [{ auctionId: 10, winnerId: 5, winningAmount: 250.0 }],
    },
    {
      match: /INSERT INTO domain_events/,
      respond: (sql, params) => {
        assert.equal(params[0], 'AuctionClosed');
        const payload = JSON.parse(params[1]);
        assert.equal(payload.auctionId, 10);
        assert.equal(payload.winnerId, 5);
        assert.equal(payload.winningAmount, 250.0);
        return { rows: [{ id: 1 }] };
      },
    },
    { match: 'COMMIT', rows: [] },
  ]);

  const results = await closeExpiredAuctions({ db, now: fixedNow });
  assert.equal(results.length, 1);

  const eventInserts = db.callsMatching(/INSERT INTO domain_events/);
  assert.equal(eventInserts.length, 1);
  assert.equal(db.callsMatching('COMMIT').length, 1);
});

test('claimBatch uses FOR UPDATE SKIP LOCKED and sets claimed_at', async () => {
  const sampleEvents = [
    {
      id: 1,
      eventType: 'BidPlaced',
      payload: JSON.stringify({ bidId: 10 }),
      createdAt: '2026-03-30T00:00:00Z',
      claimedAt: null,
    },
    {
      id: 2,
      eventType: 'AuctionClosed',
      payload: JSON.stringify({ auctionId: 5 }),
      createdAt: '2026-03-30T00:01:00Z',
      claimedAt: null,
    },
  ];

  const db = createFakeDb([
    { match: 'BEGIN', rows: [] },
    {
      match: /FOR UPDATE SKIP LOCKED/,
      rows: sampleEvents,
    },
    {
      match: /UPDATE domain_events/,
      respond: (sql, params) => ({
        rows: [
          { ...sampleEvents[0], claimedAt: params[0] },
          { ...sampleEvents[1], claimedAt: params[0] },
        ],
      }),
    },
    { match: 'COMMIT', rows: [] },
  ]);

  const claimed = await claimBatch({ db, batchSize: 5 });
  assert.equal(claimed.length, 2);
  assert.equal(claimed[0].id, 1);
  assert.equal(claimed[0].eventType, 'BidPlaced');
  assert.deepEqual(claimed[0].payload, { bidId: 10 });
  assert.equal(claimed[1].id, 2);
  assert.equal(claimed[1].eventType, 'AuctionClosed');

  const selectCalls = db.callsMatching(/FOR UPDATE SKIP LOCKED/);
  assert.equal(selectCalls.length, 1);
  assert.ok(selectCalls[0].text.includes('WHERE published_at IS NULL AND claimed_at IS NULL'));
  assert.deepEqual(selectCalls[0].params, [5]);

  const updateCalls = db.callsMatching(/UPDATE domain_events/);
  assert.equal(updateCalls.length, 1);
  assert.ok(updateCalls[0].text.includes('SET claimed_at = $1'));
  assert.deepEqual(updateCalls[0].params[1], [1, 2]);
  assert.equal(db.callsMatching('COMMIT').length, 1);
});

test('claimBatch returns empty array when no events are available', async () => {
  const db = createFakeDb([
    { match: 'BEGIN', rows: [] },
    {
      match: /FOR UPDATE SKIP LOCKED/,
      rows: [],
    },
    { match: 'COMMIT', rows: [] },
  ]);

  const claimed = await claimBatch(db, 10);
  assert.deepEqual(claimed, []);
  assert.equal(db.callsMatching(/UPDATE domain_events/).length, 0);
  assert.equal(db.callsMatching('COMMIT').length, 1);
});

test('markPublished updates claimed events after publish', async () => {
  const db = createFakeDb([
    {
      match: /UPDATE domain_events/,
      respond: (sql, params) => {
        assert.ok(sql.includes('SET published_at = $1'));
        assert.ok(sql.includes('WHERE id = ANY($2)'));
        assert.deepEqual(params[1], [10, 20]);
        return { rowCount: 2, rows: [{ id: 10 }, { id: 20 }] };
      },
    },
  ]);

  const count = await markPublished({ db, eventIds: [10, 20] });
  assert.equal(count, 2);
});

test('markPublished returns 0 when given empty array or invalid input', async () => {
  const db = createFakeDb([]);
  const countEmpty = await markPublished(db, []);
  assert.equal(countEmpty, 0);

  const countNull = await markPublished({ db, eventIds: null });
  assert.equal(countNull, 0);
  assert.equal(db.calls.length, 0);
});

test('writeEvent helper inserts event correctly', async () => {
  const db = createFakeDb([
    {
      match: /INSERT INTO domain_events/,
      respond: (sql, params) => ({
        rows: [
          {
            id: 100,
            eventType: params[0],
            payload: JSON.parse(params[1]),
            createdAt: '2026-03-30T00:00:00Z',
          },
        ],
      }),
    },
  ]);

  const row = await writeEvent(db, 'CustomEvent', { key: 'value' });
  assert.equal(row.id, 100);
  assert.equal(row.eventType, 'CustomEvent');
  assert.deepEqual(row.payload, { key: 'value' });
});
