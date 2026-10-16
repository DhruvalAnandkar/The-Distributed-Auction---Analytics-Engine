import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import { createApp } from '../src/app.js';
import { createFakeDb } from './helpers/fakeDb.js';
import { requestContext } from '../src/middleware/requestContext.js';

test('requestContext assigns a valid UUID when no incoming X-Request-Id is provided', async (t) => {
  const logOutput = [];
  t.mock.method(console, 'log', (msg) => logOutput.push(msg));

  const app = express();
  app.use(requestContext);
  app.get('/test', (req, res) => res.json({ ok: true }));

  const res = await request(app).get('/test');

  assert.equal(res.status, 200);
  assert.ok(res.headers['x-request-id']);
  assert.match(res.headers['x-request-id'], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  assert.equal(logOutput.length, 1);
  const logEntry = JSON.parse(logOutput[0]);
  assert.equal(logEntry.requestId, res.headers['x-request-id']);
  assert.equal(logEntry.method, 'GET');
  assert.equal(logEntry.path, '/test');
  assert.equal(logEntry.status, 200);
  assert.equal(typeof logEntry.durationMs, 'number');
});

test('requestContext honors a safe incoming X-Request-Id header', async (t) => {
  const logOutput = [];
  t.mock.method(console, 'log', (msg) => logOutput.push(msg));

  const app = express();
  app.use(requestContext);
  app.get('/test', (req, res) => res.json({ ok: true }));

  const customId = 'my-safe-req-id_123';
  const res = await request(app).get('/test').set('X-Request-Id', customId);

  assert.equal(res.status, 200);
  assert.equal(res.headers['x-request-id'], customId);

  assert.equal(logOutput.length, 1);
  const logEntry = JSON.parse(logOutput[0]);
  assert.equal(logEntry.requestId, customId);
});

test('requestContext replaces unsafe or overly long incoming X-Request-Id headers', async (t) => {
  const logOutput = [];
  t.mock.method(console, 'log', (msg) => logOutput.push(msg));

  const app = express();
  app.use(requestContext);
  app.get('/test', (req, res) => res.json({ ok: true }));

  // Too long (> 64 chars)
  const longId = 'a'.repeat(65);
  const resLong = await request(app).get('/test').set('X-Request-Id', longId);
  assert.notEqual(resLong.headers['x-request-id'], longId);
  assert.ok(resLong.headers['x-request-id']);

  // Unsafe characters
  const unsafeId = 'req-id with spaces!';
  const resUnsafe = await request(app).get('/test').set('X-Request-Id', unsafeId);
  assert.notEqual(resUnsafe.headers['x-request-id'], unsafeId);
});
