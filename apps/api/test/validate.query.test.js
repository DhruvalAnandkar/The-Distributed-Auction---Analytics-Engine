import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { validate } from '../src/middleware/validate.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

function buildApp() {
  const app = express();
  const querySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: z.enum(['ACTIVE', 'CLOSED']).optional(),
  });
  const paramsSchema = z.object({ id: z.coerce.number().int().positive() });

  app.get('/items', validate(querySchema, 'query'), (req, res) => {
    res.json({ query: req.query, validated: req.validated.query });
  });
  app.get('/items/:id', validate(paramsSchema, 'params'), (req, res) => {
    res.json({ id: req.params.id, type: typeof req.params.id });
  });
  app.use(errorHandler);
  return app;
}

test('validate(schema, "query") works on Express 5 read-only req.query and applies coercion/defaults', async () => {
  const res = await request(buildApp()).get('/items?limit=5&status=ACTIVE');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.query, { limit: 5, status: 'ACTIVE' });
  assert.deepEqual(res.body.validated, { limit: 5, status: 'ACTIVE' });

  const defaults = await request(buildApp()).get('/items');
  assert.equal(defaults.status, 200);
  assert.deepEqual(defaults.body.query, { limit: 20 });
});

test('validate(schema, "query") rejects invalid query strings with 400 details', async () => {
  const res = await request(buildApp()).get('/items?limit=0&status=NOPE');
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
  const fields = res.body.details.map((d) => d.field).sort();
  assert.deepEqual(fields, ['limit', 'status']);
});

test('validate(schema, "params") coerces route params', async () => {
  const ok = await request(buildApp()).get('/items/42');
  assert.deepEqual(ok.body, { id: 42, type: 'number' });

  const bad = await request(buildApp()).get('/items/abc');
  assert.equal(bad.status, 400);
});
