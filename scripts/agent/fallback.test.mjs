import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModel, resolveModelList, ModelUnavailableError } from './llm.mjs';

const overloaded = () => Object.assign(new Error('[503 Service Unavailable] This model is currently experiencing high demand.'), { status: 503 });
const noSleep = async () => {};
const quiet = (t) => t.mock.method(console, 'warn', () => {});

test('resolveModelList puts the preferred model first and dedupes', () => {
  assert.deepEqual(resolveModelList('gemini-x, gemini-3.7-flash', ['gemini-3.7-flash', 'gemini-y']), [
    'gemini-x',
    'gemini-3.7-flash',
    'gemini-y',
  ]);
  assert.deepEqual(resolveModelList('', ['a-model']), ['a-model']);
  assert.deepEqual(resolveModelList('bad name;rm -rf', ['a-model']), ['a-model']);
});

test('falls over to the next model when one stays overloaded (503)', async (t) => {
  quiet(t);
  const calls = [];
  const model = createModel({
    modelNames: ['busy-model', 'good-model'],
    callModel: async (name) => {
      calls.push(name);
      if (name === 'busy-model') throw overloaded();
      return '{"ok":true}';
    },
    sleepFn: noSleep,
  });

  assert.equal(await model.generate('p'), '{"ok":true}');
  assert.deepEqual(calls, ['busy-model', 'busy-model', 'busy-model', 'good-model']);
  assert.equal(model.name, 'good-model');

  // Sticky: the next attempt goes straight to the model that worked.
  await model.generate('p2');
  assert.equal(calls.at(-1), 'good-model');
  assert.equal(calls.length, 5);
});

test('daily quota and 404 skip to the next model without retrying', async (t) => {
  quiet(t);
  const calls = [];
  const model = createModel({
    modelNames: ['quota-model', 'missing-model', 'good-model'],
    callModel: async (name) => {
      calls.push(name);
      if (name === 'quota-model') throw new Error('429 GenerateRequestsPerDayPerProjectPerModel-FreeTier');
      if (name === 'missing-model') throw Object.assign(new Error('[404 Not Found] model not found'), { status: 404 });
      return '{}';
    },
    sleepFn: noSleep,
  });
  await model.generate('p');
  assert.deepEqual(calls, ['quota-model', 'missing-model', 'good-model']);
});

test('reports every model when all of them fail', async (t) => {
  quiet(t);
  const model = createModel({
    modelNames: ['a-model', 'b-model'],
    callModel: async () => {
      throw overloaded();
    },
    sleepFn: noSleep,
  });
  await assert.rejects(model.generate('p'), (err) => {
    assert.ok(err instanceof ModelUnavailableError);
    assert.match(err.message, /a-model: .*503/);
    assert.match(err.message, /b-model: .*503/);
    return true;
  });
});
