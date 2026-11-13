import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';
import { createEventBus } from '../src/services/eventBus.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const validToken = jwt.sign({ sub: 42, username: 'bob' }, process.env.JWT_SECRET);
const futureDate = new Date(Date.now() + 3600 * 1000).toISOString();

test('GET /api/auctions/:id/events streams ready, bid events, ping, and cleans up listener & timer on close', async () => {
  const eventBus = createEventBus();
  const db = createFakeDb([
    {
      match: /SELECT id FROM auctions WHERE id = \$1/,
      rows: [{ id: 1 }],
    },
  ]);

  const app = createApp({ db, eventBus, pingIntervalMs: 50 });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const chunks = [];
    let clientReq;

    await new Promise((resolve, reject) => {
      clientReq = http.get(`http://127.0.0.1:${port}/api/auctions/1/events`, (res) => {
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['content-type'], 'text/event-stream');
        assert.equal(res.headers['cache-control'], 'no-cache');
        assert.equal(res.headers['connection'], 'keep-alive');

        res.on('data', (chunk) => {
          chunks.push(chunk.toString());
          const fullText = chunks.join('');

          if (fullText.includes('event: ready') && !fullText.includes('event: bid')) {
            eventBus.emit('auction:1', {
              bid: {
                id: 99,
                auctionId: 1,
                bidderId: 42,
                amount: 105,
                createdAt: '2026-03-30T00:00:00Z',
              },
              auction: {
                currentPrice: 105,
              },
            });
          }

          if (fullText.includes('event: bid') && fullText.includes(': ping')) {
            resolve();
          }
        });

        res.on('error', reject);
      });

      clientReq.on('error', reject);
    });

    const streamText = chunks.join('');
    assert.ok(streamText.includes('event: ready\ndata: {"status":"ready"}\n\n'));
    assert.ok(streamText.includes('event: bid\ndata: {"bid":{"id":99,"auctionId":1,"bidderId":42,"amount":105,"createdAt":"2026-03-30T00:00:00Z"},"auction":{"currentPrice":105}}\n\n'));
    assert.ok(streamText.includes(': ping\n\n'));

    assert.equal(eventBus.listenerCount('auction:1'), 1);

    clientReq.destroy();

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(eventBus.listenerCount('auction:1'), 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Placing a bid publishes auction:<id> to eventBus after COMMIT and reaches SSE stream', async () => {
  const eventBus = createEventBus();
  const db = createFakeDb([
    {
      match: /SELECT id FROM auctions WHERE id = \$1/,
      rows: [{ id: 1 }],
    },
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
            id: 100,
            auctionId: params[0],
            bidderId: params[1],
            amount: params[2],
            createdAt: '2026-03-30T00:00:00Z',
          },
        ],
      }),
    },
    { match: /UPDATE auctions SET current_price/, rows: [] },
    { match: 'COMMIT', rows: [] },
  ]);

  const app = createApp({ db, eventBus, pingIntervalMs: 25000 });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const chunks = [];
    let clientReq;

    await new Promise((resolve, reject) => {
      clientReq = http.get(`http://127.0.0.1:${port}/api/auctions/1/events`, (res) => {
        res.on('data', (chunk) => {
          chunks.push(chunk.toString());
          const text = chunks.join('');

          if (text.includes('event: ready') && !text.includes('event: bid')) {
            const postReq = http.request(
              `http://127.0.0.1:${port}/api/auctions/1/bids`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${validToken}`,
                },
              },
              (postRes) => {
                assert.equal(postRes.statusCode, 201);
              }
            );
            postReq.on('error', reject);
            postReq.write(JSON.stringify({ amount: 110.0 }));
            postReq.end();
          }

          if (text.includes('event: bid')) {
            resolve();
          }
        });

        res.on('error', reject);
      });

      clientReq.on('error', reject);
    });

    const streamText = chunks.join('');
    assert.ok(streamText.includes('event: bid'));
    assert.ok(streamText.includes('"amount":110'));

    clientReq.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(eventBus.listenerCount('auction:1'), 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET /api/auctions/:id/events returns 404 when auction is not found', async () => {
  const db = createFakeDb([
    {
      match: /SELECT id FROM auctions WHERE id = \$1/,
      rows: [],
    },
  ]);

  const app = createApp({ db });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/api/auctions/999/events`, (res) => {
        assert.equal(res.statusCode, 404);
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          const body = JSON.parse(data);
          assert.equal(body.error, 'Auction not found');
          resolve();
        });
      });
      req.on('error', reject);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET /api/auctions/:id/events returns 400 when auction id is invalid', async () => {
  const db = createFakeDb([]);
  const app = createApp({ db });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/api/auctions/abc/events`, (res) => {
        assert.equal(res.statusCode, 400);
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          const body = JSON.parse(data);
          assert.equal(body.error, 'Validation failed');
          resolve();
        });
      });
      req.on('error', reject);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
