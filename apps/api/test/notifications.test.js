import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const userId = 42;
const token = jwt.sign({ sub: userId, username: 'alice' }, process.env.JWT_SECRET);
const otherToken = jwt.sign({ sub: 99, username: 'mallory' }, process.env.JWT_SECRET);

const sampleNotifications = [
  {
    id: 10,
    userId,
    auctionId: 1,
    type: 'OUTBID',
    read: false,
    createdAt: '2026-03-30T14:00:00Z',
  },
  {
    id: 5,
    userId,
    auctionId: 2,
    type: 'OUTBID',
    read: true,
    createdAt: '2026-03-30T12:00:00Z',
  },
];

test('Placing a bid notifies the previous highest bidder with type OUTBID inside the same transaction', async () => {
  let notifiedUserId = null;

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
          endsAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        },
      ],
    },
    {
      match: /SELECT bidder_id as "bidderId" FROM bids/,
      rows: [{ bidderId: 77 }],
    },
    {
      match: /INSERT INTO bids/,
      respond: () => ({ rows: [{ id: 200, auctionId: 1, bidderId: userId, amount: 110, createdAt: new Date().toISOString() }] }),
    },
    {
      match: /INSERT INTO notifications/,
      respond: (sql, params) => {
        notifiedUserId = params[0];
        return { rows: [{ id: 1, userId: params[0], auctionId: params[1], type: 'OUTBID' }] };
      },
    },
    { match: /UPDATE auctions/,
      rows: [],
    },
    { match: 'COMMIT', rows: [] },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/auctions/1/bids')
    .set('Authorization', `Bearer ${token}`)
    .send({ amount: 110.0 });

  assert.equal(res.status, 201);
  assert.equal(notifiedUserId, 77);
  assert.equal(db.callsMatching('BEGIN').length, 1);
  assert.equal(db.callsMatching('COMMIT').length, 1);
});

test('Placing a bid does not insert notification if there was no previous bid', async () => {
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
          endsAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        },
      ],
    },
    {
      match: /SELECT bidder_id as "bidderId" FROM bids/,
      rows: [],
    },
    {
      match: /INSERT INTO bids/,
      respond: () => ({ rows: [{ id: 200, auctionId: 1, bidderId: userId, amount: 110, createdAt: new Date().toISOString() }] }),
    },
    { match: /UPDATE auctions/, rows: [] },
    { match: 'COMMIT', rows: [] },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/auctions/1/bids')
    .set('Authorization', `Bearer ${token}`)
    .send({ amount: 110.0 });

  assert.equal(res.status, 201);
  assert.equal(db.callsMatching(/INSERT INTO notifications/).length, 0);
});

test('GET /api/users/me/notifications supports keyset pagination and unreadOnly filter', async () => {
  const db = createFakeDb([
    {
      match: /FROM notifications/,
      respond: () => ({ rows: [sampleNotifications[0]] }),
    },
  ]);

  const res = await request(createApp({ db }))
    .get('/api/users/me/notifications?unreadOnly=true&limit=1')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.notifications, [
    {
      id: 10,
      userId,
      auctionId: 1,
      type: 'OUTBID',
      read: false,
      createdAt: '2026-03-30T14:00:00Z',
    },
  ]);

  const calls = db.callsMatching(/FROM notifications/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].text.includes('user_id = $1'));
  assert.ok(calls[0].text.includes('read = FALSE'));
  assert.deepEqual(calls[0].params, [userId, 2]);
});

test('POST /api/users/me/notifications/:id/read marks notification as read (own notifications only)', async () => {
  const db = createFakeDb([
    {
      match: /UPDATE notifications/,
      respond: () => ({
        rows: [
          {
            id: 10,
            userId,
            auctionId: 1,
            type: 'OUTBID',
            read: true,
            createdAt: '2026-03-30T14:00:00Z',
          },
        ],
      }),
    },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/users/me/notifications/10/read')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.notification.read, true);

  const calls = db.callsMatching(/UPDATE notifications/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [10, userId]);
});

test('POST /api/users/me/notifications/:id/read returns 404 for non-existent or other user notification (no leakage)', async () => {
  const db = createFakeDb([
    {
      match: /UPDATE notifications/,
      rows: [],
    },
  ]);

  const res = await request(createApp({ db }))
    .post('/api/users/me/notifications/999/read')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Notification not found' });

  const calls = db.callsMatching(/UPDATE notifications/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [999, userId]);
});

test('GET /api/users/me/notifications returns 401 without auth token', async () => {
  const db = createFakeDb([]);
  const res = await request(createApp({ db })).get('/api/users/me/notifications');
  assert.equal(res.status, 401);
  assert.equal(db.calls.length, 0);
});

test('Notification endpoints return 500 on database error', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = createFakeDb([
    {
      match: /FROM notifications/,
      error: new Error('DB error'),
    },
  ]);

  const res = await request(createApp({ db }))
    .get('/api/users/me/notifications')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'Internal server error' });
});
