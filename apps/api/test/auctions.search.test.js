import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';
import { escapeLike } from '../src/utils/escapeLike.js';

const sampleAuctions = [
  {
    id: 10,
    title: 'Vintage Gold Watch',
    description: 'Gold watch in great condition',
    startPrice: 100,
    currentPrice: 150,
    status: 'ACTIVE',
    sellerId: 1,
    endsAt: '2026-12-31T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 9,
    title: 'Silver Watch 50% Off',
    description: 'Brand new silver watch',
    startPrice: 50,
    currentPrice: 50,
    status: 'ACTIVE',
    sellerId: 2,
    endsAt: '2026-12-31T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
  },
];

test('escapeLike escapes %, _ and \\ characters properly', () => {
  assert.equal(escapeLike('simple'), 'simple');
  assert.equal(escapeLike('50%'), '50\\%');
  assert.equal(escapeLike('item_1'), 'item\\_1');
  assert.equal(escapeLike('back\\slash'), 'back\\\\slash');
  assert.equal(escapeLike('combo%_\\all'), 'combo\\%\\_\\\\all');
});

test('GET /api/auctions with ?q searches title case-insensitively using bound parameter', async () => {
  const db = createFakeDb([
    {
      match: /FROM auctions/,
      rows: [sampleAuctions[0]],
    },
  ]);

  const res = await request(createApp({ db })).get('/api/auctions?q=watch');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.auctions, [sampleAuctions[0]]);
  assert.deepEqual(res.body.pagination, { nextCursor: null });

  const calls = db.callsMatching(/FROM auctions/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].text.includes('WHERE title ILIKE $1'));
  assert.ok(!calls[0].text.includes('watch'));
  assert.deepEqual(calls[0].params, ['%watch%', 21]);
});

test('GET /api/auctions with ?q escapes %, _ and \\ so they are matched literally', async () => {
  const db = createFakeDb([
    {
      match: /FROM auctions/,
      rows: [sampleAuctions[1]],
    },
  ]);

  const rawQuery = '50%_off\\item';
  const res = await request(createApp({ db })).get(`/api/auctions?q=${encodeURIComponent(rawQuery)}`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.auctions, [sampleAuctions[1]]);

  const calls = db.callsMatching(/FROM auctions/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].text.includes('WHERE title ILIKE $1'));
  assert.equal(calls[0].params[0], '%50\\%\\_off\\\\item%');
  assert.equal(calls[0].params[1], 21);
  assert.ok(!calls[0].text.includes('50%'));
  assert.ok(!calls[0].text.includes('off'));
});

test('GET /api/auctions combines ?q with status filter and keyset pagination', async () => {
  const db = createFakeDb([
    {
      match: /FROM auctions/,
      rows: [sampleAuctions[0]],
    },
  ]);

  const res = await request(createApp({ db }))
    .get('/api/auctions?q=watch&status=ACTIVE&cursor=15&limit=10');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.auctions, [sampleAuctions[0]]);

  const calls = db.callsMatching(/FROM auctions/);
  assert.equal(calls.length, 1);
  assert.ok(
    calls[0].text.includes('WHERE status = $1 AND title ILIKE $2 AND id < $3')
  );
  assert.ok(calls[0].text.includes('ORDER BY id DESC'));
  assert.ok(calls[0].text.includes('LIMIT $4'));
  assert.deepEqual(calls[0].params, ['ACTIVE', '%watch%', 15, 11]);
});

test('GET /api/auctions combines ?q with cursor without status', async () => {
  const db = createFakeDb([
    {
      match: /FROM auctions/,
      rows: [sampleAuctions[0]],
    },
  ]);

  const res = await request(createApp({ db }))
    .get('/api/auctions?q=gold&cursor=20&limit=5');

  assert.equal(res.status, 200);

  const calls = db.callsMatching(/FROM auctions/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].text.includes('WHERE title ILIKE $1 AND id < $2'));
  assert.deepEqual(calls[0].params, ['%gold%', 20, 6]);
});

test('GET /api/auctions combines ?q with status without cursor', async () => {
  const db = createFakeDb([
    {
      match: /FROM auctions/,
      rows: [sampleAuctions[0]],
    },
  ]);

  const res = await request(createApp({ db }))
    .get('/api/auctions?q=watch&status=ACTIVE');

  assert.equal(res.status, 200);

  const calls = db.callsMatching(/FROM auctions/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].text.includes('WHERE status = $1 AND title ILIKE $2'));
  assert.deepEqual(calls[0].params, ['ACTIVE', '%watch%', 21]);
});

test('GET /api/auctions returns 400 when q is longer than 100 characters', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  const overlyLongQuery = 'a'.repeat(101);
  const res = await request(app).get(`/api/auctions?q=${overlyLongQuery}`);

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
  assert.ok(Array.isArray(res.body.details));
  assert.ok(res.body.details.some((d) => d.field === 'q'));
  assert.equal(db.calls.length, 0);
});

test('GET /api/auctions accepts q with exactly 100 characters', async () => {
  const db = createFakeDb([
    {
      match: /FROM auctions/,
      rows: [],
    },
  ]);

  const hundredCharQuery = 'x'.repeat(100);
  const res = await request(createApp({ db })).get(`/api/auctions?q=${hundredCharQuery}`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.auctions, []);
  const calls = db.callsMatching(/FROM auctions/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[0], `%${hundredCharQuery}%`);
});

test('GET /api/auctions returns 400 when q is empty string', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  const res = await request(app).get('/api/auctions?q=');

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
  assert.ok(res.body.details.some((d) => d.field === 'q'));
  assert.equal(db.calls.length, 0);
});

test('GET /api/auctions with ?q returns 500 when database query fails', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = createFakeDb([
    {
      match: /FROM auctions/,
      error: new Error('Database connection failed'),
    },
  ]);

  const res = await request(createApp({ db })).get('/api/auctions?q=watch');

  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'Internal server error' });
});
