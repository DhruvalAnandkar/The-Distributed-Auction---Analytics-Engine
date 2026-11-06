import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';

const sampleAuction1 = {
  id: 1,
  title: 'Vintage Gold Watch',
  description: 'Gold watch in great condition',
  startPrice: 100,
  currentPrice: 150,
  status: 'ACTIVE',
  sellerId: 10,
  endsAt: '2026-12-31T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
};

const sampleAuction2 = {
  ...sampleAuction1,
  currentPrice: 200,
};

test('GET /api/auctions/:id returns ETag (SHA-256 of body) and Cache-Control headers', async () => {
  const db = createFakeDb([
    {
      match: /WHERE id = \$1/,
      rows: [sampleAuction1],
    },
  ]);

  const res = await request(createApp({ db })).get('/api/auctions/1');

  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'private, max-age=0, must-revalidate');

  const expectedBody = { auction: sampleAuction1 };
  const expectedHash = crypto.createHash('sha256').update(JSON.stringify(expectedBody)).digest('hex');
  assert.equal(res.headers['etag'], `"${expectedHash}"`);
});

test('GET /api/auctions/:id returns 304 when If-None-Match matches ETag', async () => {
  const db = createFakeDb([
    {
      match: /WHERE id = \$1/,
      rows: [sampleAuction1],
    },
  ]);

  const expectedBody = { auction: sampleAuction1 };
  const expectedHash = crypto.createHash('sha256').update(JSON.stringify(expectedBody)).digest('hex');
  const etag = `"${expectedHash}"`;

  const app = createApp({ db });

  // Test with exact quoted etag
  const resQuoted = await request(app)
    .get('/api/auctions/1')
    .set('If-None-Match', etag);

  assert.equal(resQuoted.status, 304);
  assert.equal(resQuoted.text, '');
  assert.equal(resQuoted.headers['cache-control'], 'private, max-age=0, must-revalidate');
  assert.equal(resQuoted.headers['etag'], etag);

  // Test with unquoted raw hash
  const resUnquoted = await request(app)
    .get('/api/auctions/1')
    .set('If-None-Match', expectedHash);

  assert.equal(resUnquoted.status, 304);

  // Test with weak tag format W/"hash"
  const resWeak = await request(app)
    .get('/api/auctions/1')
    .set('If-None-Match', `W/${etag}`);

  assert.equal(resWeak.status, 304);
});

test('GET /api/auctions/:id returns 200 with updated body and new ETag when body changes', async () => {
  const expectedHash1 = crypto.createHash('sha256').update(JSON.stringify({ auction: sampleAuction1 })).digest('hex');
  const expectedHash2 = crypto.createHash('sha256').update(JSON.stringify({ auction: sampleAuction2 })).digest('hex');

  assert.notEqual(expectedHash1, expectedHash2);

  const db = createFakeDb([
    {
      match: /WHERE id = \$1/,
      rows: [sampleAuction2],
    },
  ]);

  const res = await request(createApp({ db }))
    .get('/api/auctions/1')
    .set('If-None-Match', `"${expectedHash1}"`);

  assert.equal(res.status, 200);
  assert.equal(res.headers['etag'], `"${expectedHash2}"`);
  assert.deepEqual(res.body, { auction: sampleAuction2 });
});

test('GET /api/auctions/:id returns 404 when auction is not found', async () => {
  const db = createFakeDb([
    {
      match: /WHERE id = \$1/,
      rows: [],
    },
  ]);

  const res = await request(createApp({ db })).get('/api/auctions/999');

  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Auction not found' });
});

test('GET /api/auctions/:id returns 500 on database failure', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = createFakeDb([
    {
      match: /WHERE id = \$1/,
      error: new Error('Database connection failed'),
    },
  ]);

  const res = await request(createApp({ db })).get('/api/auctions/1');

  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'Internal server error' });
});
