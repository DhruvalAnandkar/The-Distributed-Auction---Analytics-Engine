import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';

test('GET /api/users/:id returns public profile with SQL computed auctionCount and no email or password', async () => {
  const db = createFakeDb([
    {
      match: /FROM users u/,
      rows: [
        {
          id: 15,
          username: 'charlie',
          createdAt: '2026-02-15T10:00:00.000Z',
          auctionCount: 4,
        },
      ],
    },
  ]);

  const res = await request(createApp({ db })).get('/api/users/15');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    user: {
      id: 15,
      username: 'charlie',
      createdAt: '2026-02-15T10:00:00.000Z',
      auctionCount: 4,
    },
  });
  assert.equal(res.body.user.email, undefined);
  assert.equal(res.body.user.password, undefined);

  const calls = db.callsMatching(/FROM users u/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].text.includes('LEFT JOIN auctions'));
  assert.ok(calls[0].text.includes('COUNT(a.id)'));
  assert.ok(calls[0].text.includes('WHERE u.id = $1'));
  assert.deepEqual(calls[0].params, [15]);
});

test('GET /api/users/:id returns auctionCount 0 for user without auctions', async () => {
  const db = createFakeDb([
    {
      match: /FROM users u/,
      rows: [
        {
          id: 20,
          username: 'newbie',
          createdAt: '2026-03-01T00:00:00.000Z',
          auctionCount: 0,
        },
      ],
    },
  ]);

  const res = await request(createApp({ db })).get('/api/users/20');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    user: {
      id: 20,
      username: 'newbie',
      createdAt: '2026-03-01T00:00:00.000Z',
      auctionCount: 0,
    },
  });
});

test('GET /api/users/:id returns 404 when user is not found', async () => {
  const db = createFakeDb([
    {
      match: /FROM users u/,
      rows: [],
    },
  ]);

  const res = await request(createApp({ db })).get('/api/users/999');

  assert.equal(res.status, 404);
  assert.deepEqual(res.body, {
    error: 'User not found',
  });
});

test('GET /api/users/:id returns 400 for non-numeric, zero, or negative id', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  const resNonNumeric = await request(app).get('/api/users/not-a-number');
  assert.equal(resNonNumeric.status, 400);
  assert.equal(resNonNumeric.body.error, 'Validation failed');
  assert.ok(resNonNumeric.body.details.some((d) => d.field === 'id'));

  const resZero = await request(app).get('/api/users/0');
  assert.equal(resZero.status, 400);
  assert.equal(resZero.body.error, 'Validation failed');

  const resNegative = await request(app).get('/api/users/-10');
  assert.equal(resNegative.status, 400);
  assert.equal(resNegative.body.error, 'Validation failed');

  assert.equal(db.calls.length, 0);
});

test('GET /api/users/:id returns 500 when database fails', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = createFakeDb([
    {
      match: /FROM users u/,
      error: new Error('Database connection failed'),
    },
  ]);

  const res = await request(createApp({ db })).get('/api/users/15');

  assert.equal(res.status, 500);
  assert.deepEqual(res.body, {
    error: 'Internal server error',
  });
});
