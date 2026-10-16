import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';
import { createRateLimiter } from '../src/middleware/rateLimit.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

test('rate limiter allows requests up to capacity and rejects excess with 429 and Retry-After', async () => {
  let currentTime = 1000000;
  const limiter = createRateLimiter({
    capacity: 2,
    refillPerSecond: 1,
    key: () => 'client-1',
    now: () => currentTime,
  });

  const app = express();
  app.use(express.json());
  app.get('/test', limiter, (req, res) => res.json({ ok: true }));
  app.use(errorHandler);

  const res1 = await request(app).get('/test');
  assert.equal(res1.status, 200);

  const res2 = await request(app).get('/test');
  assert.equal(res2.status, 200);

  const res3 = await request(app).get('/test');
  assert.equal(res3.status, 429);
  assert.deepEqual(res3.body, { error: 'Too many requests, please try again later' });
  assert.ok(res3.headers['retry-after']);
});

test('tokens refill over time using injected clock', async () => {
  let currentTime = 1000000;
  const limiter = createRateLimiter({
    capacity: 1,
    refillPerSecond: 1, // 1 token per second
    key: () => 'client-2',
    now: () => currentTime,
  });

  const app = express();
  app.use(express.json());
  app.get('/test', limiter, (req, res) => res.json({ ok: true }));
  app.use(errorHandler);

  // Exhaust capacity (1 token)
  const res1 = await request(app).get('/test');
  assert.equal(res1.status, 200);

  const res2 = await request(app).get('/test');
  assert.equal(res2.status, 429);

  // Advance time by 1000ms (1 second), refilling 1 token
  currentTime += 1000;

  const res3 = await request(app).get('/test');
  assert.equal(res3.status, 200);
});

test('buckets are independent per key', async () => {
  let currentTime = 1000000;
  const limiter = createRateLimiter({
    capacity: 1,
    refillPerSecond: 1,
    key: (req) => req.query.user,
    now: () => currentTime,
  });

  const app = express();
  app.use(express.json());
  app.get('/test', limiter, (req, res) => res.json({ ok: true }));
  app.use(errorHandler);

  // Exhaust bucket for userA
  const resA1 = await request(app).get('/test?user=userA');
  assert.equal(resA1.status, 200);
  const resA2 = await request(app).get('/test?user=userA');
  assert.equal(resA2.status, 429);

  // userB should still have their own bucket capacity
  const resB1 = await request(app).get('/test?user=userB');
  assert.equal(resB1.status, 200);
});

test('POST /api/users/login enforces rate limiting by IP', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = createFakeDb([
    {
      match: /SELECT .* FROM users WHERE email/,
      rows: [],
    },
  ]);

  const app = createApp({ db });

  // Send login requests up to capacity (5)
  for (let i = 0; i < 5; i++) {
    const res = await request(app)
      .post('/api/users/login')
      .send({ email: 'alice@example.com', password: 'WrongPassword123!' });
    assert.equal(res.status, 401);
  }

  // 6th request should hit rate limit (429)
  const resRateLimited = await request(app)
    .post('/api/users/login')
    .send({ email: 'alice@example.com', password: 'WrongPassword123!' });

  assert.equal(resRateLimited.status, 429);
  assert.equal(resRateLimited.body.error, 'Too many requests, please try again later');
  assert.ok(resRateLimited.headers['retry-after']);
});

test('POST /api/auctions/:id/bids enforces rate limiting by user id', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = createFakeDb([]);
  const app = createApp({ db });

  const token = jwt.sign({ sub: 77, username: 'bidder' }, process.env.JWT_SECRET);

  // Send 10 valid requests (capacity is 10), each failing downstream because auction doesn't exist (404 or 409 or similar, but NOT 429)
  for (let i = 0; i < 10; i++) {
    const res = await request(app)
      .post('/api/auctions/1/bids')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 150.0 });
    assert.notEqual(res.status, 429);
  }

  // 11th request should be rate limited with 429
  const resRateLimited = await request(app)
    .post('/api/auctions/1/bids')
    .set('Authorization', `Bearer ${token}`)
    .send({ amount: 150.0 });

  assert.equal(resRateLimited.status, 429);
  assert.equal(resRateLimited.body.error, 'Too many requests, please try again later');
  assert.ok(resRateLimited.headers['retry-after']);
});
