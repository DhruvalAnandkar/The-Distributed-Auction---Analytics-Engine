import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestEnv, parseTapSummary } from './verify.mjs';
import { isDailyQuotaError, isRetryable, retryDelayMs, parseModelJson } from './llm.mjs';

test('buildTestEnv never passes secrets to model-written code', () => {
  const env = buildTestEnv({
    PATH: '/usr/bin',
    HOME: '/home/runner',
    GEMINI_API_KEY: 'secret',
    GH_TOKEN: 'secret',
    GITHUB_TOKEN: 'secret',
    DB_PASSWORD: 'secret',
    ACTIONS_RUNTIME_TOKEN: 'secret',
  });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'JWT_SECRET', 'NODE_ENV', 'PATH']);
  assert.ok(!Object.values(env).includes('secret'));
});

test('daily quota errors are not retried; per-minute ones are', () => {
  const daily = new Error('[429] Quota exceeded: GenerateRequestsPerDayPerProjectPerModel-FreeTier');
  const minute = new Error('[429 Too Many Requests] Quota exceeded. Please retry in 37.2s.');
  assert.equal(isDailyQuotaError(daily), true);
  assert.equal(isRetryable(daily), false);
  assert.equal(isRetryable(minute), true);
  assert.equal(retryDelayMs(minute, 2000), 37_700);
  assert.equal(retryDelayMs(new Error('503 overloaded'), 4000), 4000);
  assert.equal(retryDelayMs(new Error('retry in 900s'), 2000), 90_000);
});

test('parseModelJson tolerates fences and leading prose', () => {
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseModelJson('Here you go: {"a":2}'), { a: 2 });
  assert.throws(() => parseModelJson('no json here'));
});

test('parseTapSummary reads the final TAP counters', () => {
  const s = parseTapSummary('ok 1 - a\n# tests 3\n# pass 2\n# fail 1\n# cancelled 0\n');
  assert.deepEqual(s, { tests: 3, pass: 2, fail: 1, cancelled: 0 });
});
