import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';

const sampleAuction = {
  id: 1,
  title: 'Vintage Watch',
  startPrice: 100,
  currentPrice: 150,
  status: 'ACTIVE',
};

const sampleMinutePoints = [
  {
    bucketStart: '2026-03-30T12:01:00.000Z',
    maxAmount: '120.00',
    bidCount: 2,
  },
  {
    bucketStart: '2026-03-30T12:05:00.000Z',
    maxAmount: '150.00',
    bidCount: 1,
  },
];

test('GET /api/auctions/:id/price-history?bucket=minute returns bucketed price history points', async () => {
  const db = createFakeDb([
    {
      match: /SELECT id FROM auctions WHERE id = \$1/,
      rows: [sampleAuction],
    },
    {
      match: /date_trunc/,
      rows: sampleMinutePoints,
    },
  ]);

  const res = await request(createApp({ db })).get('/api/auctions/1/price-history?bucket=minute');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    auctionId: 1,
    bucket: 'minute',
    points: [
      {
        bucketStart: '2026-03-30T12:01:00.000Z',
        maxAmount: 120,
        bidCount: 2,
      },
      {
        bucketStart: '2026-03-30T12:05:00.000Z',
        maxAmount: 150,
        bidCount: 1,
      },
    ],
  });

  const truncCalls = db.callsMatching(/date_trunc/);
  assert.equal(truncCalls.length, 1);
  assert.ok(truncCalls[0].text.includes('date_trunc($2, b.created_at)'));
  assert.ok(truncCalls[0].text.includes('WHERE b.auction_id = $1'));
  assert.ok(truncCalls[0].text.includes('GROUP BY date_trunc($2, b.created_at)'));
  assert.ok(truncCalls[0].text.includes('ORDER BY "bucketStart" ASC'));
  assert.deepEqual(truncCalls[0].params, [1, 'minute']);
});

test('GET /api/auctions/:id/price-history?bucket=hour accepts hour bucket and queries with hour unit', async () => {
  const hourPoint = {
    bucketStart: '2026-03-30T12:00:00.000Z',
    maxAmount: '150.00',
    bidCount: 3,
  };

  const db = createFakeDb([
    {
      match: /SELECT id FROM auctions WHERE id = \$1/,
      rows: [sampleAuction],
    },
    {
      match: /date_trunc/,
      rows: [hourPoint],
    },
  ]);

  const res = await request(createApp({ db })).get('/api/auctions/1/price-history?bucket=hour');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    auctionId: 1,
    bucket: 'hour',
    points: [
      {
        bucketStart: '2026-03-30T12:00:00.000Z',
        maxAmount: 150,
        bidCount: 3,
      },
    ],
  });

  const truncCalls = db.callsMatching(/date_trunc/);
  assert.equal(truncCalls.length, 1);
  assert.deepEqual(truncCalls[0].params, [1, 'hour']);
});

test('GET /api/auctions/:id/price-history?bucket=day accepts day bucket and queries with day unit', async () => {
  const dayPoint = {
    bucketStart: '2026-03-30T00:00:00.000Z',
    maxAmount: '150.00',
    bidCount: 3,
  };

  const db = createFakeDb([
    {
      match: /SELECT id FROM auctions WHERE id = \$1/,
      rows: [sampleAuction],
    },
    {
      match: /date_trunc/,
      rows: [dayPoint],
    },
  ]);

  const res = await request(createApp({ db })).get('/api/auctions/1/price-history?bucket=day');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    auctionId: 1,
    bucket: 'day',
    points: [
      {
        bucketStart: '2026-03-30T00:00:00.000Z',
        maxAmount: 150,
        bidCount: 3,
      },
    ],
  });

  const truncCalls = db.callsMatching(/date_trunc/);
  assert.equal(truncCalls.length, 1);
  assert.deepEqual(truncCalls[0].params, [1, 'day']);
});

test('GET /api/auctions/:id/price-history converts Date instances for bucketStart correctly', async () => {
  const dateInstance = new Date('2026-03-30T12:00:00.000Z');
  const db = createFakeDb([
    {
      match: /SELECT id FROM auctions WHERE id = \$1/,
      rows: [sampleAuction],
    },
    {
      match: /date_trunc/,
      rows: [
        {
          bucketStart: dateInstance,
          maxAmount: 200,
          bidCount: 5,
        },
      ],
    },
  ]);

  const res = await request(createApp({ db })).get('/api/auctions/1/price-history?bucket=hour');

  assert.equal(res.status, 200);
  assert.equal(res.body.points[0].bucketStart, '2026-03-30T12:00:00.000Z');
  assert.equal(res.body.points[0].maxAmount, 200);
  assert.equal(res.body.points[0].bidCount, 5);
});

test('GET /api/auctions/:id/price-history returns empty points when auction has no bids', async () => {
  const db = createFakeDb([
    {
      match: /SELECT id FROM auctions WHERE id = \$1/,
      rows: [sampleAuction],
    },
    {
      match: /date_trunc/,
      rows: [],
    },
  ]);

  const res = await request(createApp({ db })).get('/api/auctions/1/price-history?bucket=minute');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    auctionId: 1,
    bucket: 'minute',
    points: [],
  });
});

test('GET /api/auctions/:id/price-history returns 400 for invalid bucket value', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  const resSecond = await request(app).get('/api/auctions/1/price-history?bucket=second');
  assert.equal(resSecond.status, 400);
  assert.equal(resSecond.body.error, 'Validation failed');
  assert.ok(resSecond.body.details.some((d) => d.field === 'bucket'));

  const resMonth = await request(app).get('/api/auctions/1/price-history?bucket=month');
  assert.equal(resMonth.status, 400);

  const resArbitrary = await request(app).get('/api/auctions/1/price-history?bucket=foo');
  assert.equal(resArbitrary.status, 400);

  assert.equal(db.calls.length, 0);
});

test('GET /api/auctions/:id/price-history returns 400 when bucket is missing', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  const res = await request(app).get('/api/auctions/1/price-history');
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
  assert.ok(res.body.details.some((d) => d.field === 'bucket'));
  assert.equal(db.calls.length, 0);
});

test('GET /api/auctions/:id/price-history returns 400 for non-numeric or non-positive auction id', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });

  const resNan = await request(app).get('/api/auctions/abc/price-history?bucket=hour');
  assert.equal(resNan.status, 400);
  assert.equal(resNan.body.error, 'Validation failed');
  assert.ok(resNan.body.details.some((d) => d.field === 'id'));

  const resZero = await request(app).get('/api/auctions/0/price-history?bucket=hour');
  assert.equal(resZero.status, 400);

  const resNegative = await request(app).get('/api/auctions/-5/price-history?bucket=hour');
  assert.equal(resNegative.status, 400);

  assert.equal(db.calls.length, 0);
});

test('GET /api/auctions/:id/price-history returns 404 when auction is not found', async () => {
  const db = createFakeDb([
    {
      match: /SELECT id FROM auctions WHERE id = \$1/,
      rows: [],
    },
  ]);

  const res = await request(createApp({ db })).get('/api/auctions/999/price-history?bucket=day');

  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Auction not found' });
  assert.equal(db.callsMatching(/date_trunc/).length, 0);
});

test('GET /api/auctions/:id/price-history returns 500 when database fails', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = createFakeDb([
    {
      match: /SELECT id FROM auctions WHERE id = \$1/,
      error: new Error('Database connection failed'),
    },
  ]);

  const res = await request(createApp({ db })).get('/api/auctions/1/price-history?bucket=minute');

  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'Internal server error' });
});
