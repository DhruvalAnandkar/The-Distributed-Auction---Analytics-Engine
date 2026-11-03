import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';
import { createMetrics, getRoutePattern } from '../src/services/metrics.js';

test('createMetrics unit: observe and toPrometheus format counter and histogram correctly', () => {
  const metrics = createMetrics();
  metrics.observe('GET', '/api/auctions', 200, 0.05);

  const text = metrics.toPrometheus();
  assert.ok(text.includes('# HELP http_requests_total Total number of HTTP requests'));
  assert.ok(text.includes('# TYPE http_requests_total counter'));
  assert.ok(text.includes('http_requests_total{method="GET",route="/api/auctions",status="200"} 1'));
  assert.ok(text.includes('# HELP http_request_duration_seconds HTTP request duration in seconds'));
  assert.ok(text.includes('# TYPE http_request_duration_seconds histogram'));
  assert.ok(text.includes('http_request_duration_seconds_bucket{le="0.05",method="GET",route="/api/auctions",status="200"} 1'));
  assert.ok(text.includes('http_request_duration_seconds_count{method="GET",route="/api/auctions",status="200"} 1'));
});

test('createMetrics({ now }) is injectable for deterministic duration calculation', async () => {
  let timeMs = 1000;
  const now = () => timeMs;
  const metrics = createMetrics({ now });

  const db = createFakeDb([{ match: 'SELECT 1', rows: [{ '?column?': 1 }] }]);
  const app = createApp({ db, metrics });

  timeMs = 1050; // 50ms duration (0.05s)

  const res = await request(app).get('/health');
  assert.equal(res.status, 200);

  const metricsRes = await request(app).get('/metrics');
  assert.equal(metricsRes.status, 200);
  assert.match(metricsRes.headers['content-type'], /text\/plain/);
  assert.ok(metricsRes.text.includes('route="/health"'));
});

test('GET /metrics collects route patterns rather than raw path IDs', async () => {
  const db = createFakeDb([
    {
      match: /WHERE id = \$1/,
      rows: [
        {
          id: 42,
          title: 'Test Item',
          description: 'Desc',
          startPrice: 10,
          currentPrice: 10,
          status: 'ACTIVE',
          sellerId: 1,
          endsAt: '2026-12-31T00:00:00Z',
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    },
  ]);
  const app = createApp({ db });

  const resAuction = await request(app).get('/api/auctions/42');
  assert.equal(resAuction.status, 200);

  const resMetrics = await request(app).get('/metrics');
  assert.equal(resMetrics.status, 200);

  assert.ok(resMetrics.text.includes('route="/api/auctions/:id"'));
  assert.ok(!resMetrics.text.includes('route="/api/auctions/42"'));
});

test('GET /metrics enforces METRICS_TOKEN authentication using timingSafeEqual when METRICS_TOKEN is set', async (t) => {
  const originalToken = process.env.METRICS_TOKEN;
  const spy = t.mock.method(crypto, 'timingSafeEqual');

  try {
    process.env.METRICS_TOKEN = 'secret-metrics-token-123';
    const db = createFakeDb([]);
    const app = createApp({ db });

    const resNoHeader = await request(app).get('/metrics');
    assert.equal(resNoHeader.status, 401);
    assert.deepEqual(resNoHeader.body, { error: 'Missing or invalid metrics token' });

    const resMalformed = await request(app).get('/metrics').set('Authorization', 'Basic secret-metrics-token-123');
    assert.equal(resMalformed.status, 401);
    assert.deepEqual(resMalformed.body, { error: 'Missing or invalid metrics token' });

    const resWrong = await request(app)
      .get('/metrics')
      .set('Authorization', 'Bearer wrong-metrics-token-999');
    assert.equal(resWrong.status, 401);
    assert.deepEqual(resWrong.body, { error: 'Invalid metrics token' });
    assert.ok(spy.mock.calls.length >= 1);

    const resValid = await request(app)
      .get('/metrics')
      .set('Authorization', 'Bearer secret-metrics-token-123');
    assert.equal(resValid.status, 200);
    assert.ok(resValid.text.includes('# HELP http_requests_total'));
  } finally {
    process.env.METRICS_TOKEN = originalToken;
  }
});

test('getRoutePattern helper returns expected route patterns or fallback', () => {
  assert.equal(getRoutePattern(null), 'unknown');
  assert.equal(getRoutePattern({}), 'unknown');
  assert.equal(getRoutePattern({ route: { path: '/health' } }), '/health');
  assert.equal(getRoutePattern({ baseUrl: '/api/auctions', route: { path: '/:id' } }), '/api/auctions/:id');
  assert.equal(getRoutePattern({ baseUrl: '/api/auctions', route: { path: '/' } }), '/api/auctions');
});
