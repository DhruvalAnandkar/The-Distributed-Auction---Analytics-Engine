import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const validToken = jwt.sign({ sub: 42, username: 'alice' }, process.env.JWT_SECRET);

const futureDate = new Date(Date.now() + 120 * 1000).toISOString();

const validPayload = {
  title: 'Vintage Watch',
  description: 'A very nice watch',
  startPrice: 99.99,
  endsAt: futureDate,
};

test('POST /api/auctions creates an auction successfully with 201 and camelCase fields', async () => {
  const db = createFakeDb([
    {
      match: /INSERT INTO auctions/,
      respond: (sql, params) => ({
        rows: [
          {
            id: 10,
            title: params[0],
            description: params[1],
            startPrice: parseFloat(params[2]),
            currentPrice: parseFloat(params[2]),
            status: 'ACTIVE',
            sellerId: params[3],
            endsAt: params[4],
            createdAt: '2026-03-30T00:00:00Z',
          },
        ],
      }),
    },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/auctions')
    .set('Authorization', `Bearer ${validToken}`)
    .send(validPayload);

  assert.equal(res.status, 201);
  assert.ok(res.body.auction);
  assert.equal(res.body.auction.id, 10);
  assert.equal(res.body.auction.title, 'Vintage Watch');
  assert.equal(res.body.auction.startPrice, 99.99);
  assert.equal(res.body.auction.currentPrice, 99.99);
  assert.equal(res.body.auction.status, 'ACTIVE');
  assert.equal(res.body.auction.sellerId, 42);
  assert.equal(res.body.auction.endsAt, futureDate);

  const calls = db.callsMatching(/INSERT INTO auctions/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [
    'Vintage Watch',
    'A very nice watch',
    99.99,
    42,
    futureDate,
  ]);
});

test('POST /api/auctions returns 401 without an authorization token', async () => {
  const db = createFakeDb([]);

  const res = await request(createApp({ db }))
    .post('/api/auctions')
    .send(validPayload);

  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Missing or malformed authorization token' });
  assert.equal(db.calls.length, 0);
});

test('POST /api/auctions returns 400 with validation details for invalid input', async () => {
  const db = createFakeDb([]);

  const pastDate = new Date(Date.now() - 60 * 1000).toISOString();

  const res = await request(createApp({ db }))
    .post('/api/auctions')
    .set('Authorization', `Bearer ${validToken}`)
    .send({
      title: 'AB',
      startPrice: -10,
      endsAt: pastDate,
    });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
  assert.ok(Array.isArray(res.body.details));
  assert.ok(res.body.details.length >= 3);
  assert.equal(db.calls.length, 0);
});

test('POST /api/auctions returns 500 on database failure', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = createFakeDb([
    {
      match: /INSERT INTO auctions/,
      error: new Error('db insert failed'),
    },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/auctions')
    .set('Authorization', `Bearer ${validToken}`)
    .send(validPayload);

  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'Internal server error' });
});
