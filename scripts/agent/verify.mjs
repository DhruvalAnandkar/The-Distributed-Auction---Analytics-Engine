/**
 * @fileoverview Closed-loop verification: syntax check every changed file, then
 * run the full API test suite and parse the TAP summary.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';

const TEST_TIMEOUT_MS = 180_000;

/** `node --check` on each changed .js file. Returns errors. */
export function checkSyntax(repoRoot, repoPaths) {
  const errors = [];
  for (const p of repoPaths.filter((f) => f.endsWith('.js'))) {
    const r = spawnSync(process.execPath, ['--check', path.join(repoRoot, p)], { encoding: 'utf8' });
    if (r.status !== 0) {
      errors.push(`${p}: syntax error\n${(r.stderr || '').trim().split('\n').slice(0, 8).join('\n')}`);
    }
  }
  return errors;
}

/** Parses the `# tests N` / `# pass N` / `# fail N` summary of a TAP stream. */
export function parseTapSummary(output) {
  const read = (key) => {
    const matches = [...output.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gm'))];
    return matches.length ? Number(matches[matches.length - 1][1]) : null;
  };
  return {
    tests: read('tests'),
    pass: read('pass'),
    fail: read('fail'),
    cancelled: read('cancelled'),
  };
}

/** Environment variables a test process may inherit. Everything else is dropped. */
const SAFE_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SYSTEMROOT', 'CI'];

/**
 * Builds the environment for running model-written code. It is an ALLOW-list:
 * API keys, GitHub tokens and database credentials never reach the tests, so
 * generated code cannot read or exfiltrate them.
 */
export function buildTestEnv(parentEnv = process.env) {
  const env = {};
  for (const key of SAFE_ENV_KEYS) {
    if (parentEnv[key] !== undefined) env[key] = parentEnv[key];
  }
  env.NODE_ENV = 'test';
  env.JWT_SECRET = 'test-secret';
  return env;
}

/**
 * Runs the API test suite in a child process with a scrubbed environment.
 * No database env is passed, so a test that hits real Postgres fails fast.
 */
export function runTests(repoRoot) {
  const cwd = path.join(repoRoot, 'apps', 'api');
  const env = buildTestEnv();

  const r = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', '--test-timeout=20000', 'test/**/*.test.js'],
    { cwd, env, encoding: 'utf8', timeout: TEST_TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024 }
  );

  const output = `${r.stdout || ''}\n${r.stderr || ''}`;
  const summary = parseTapSummary(output);
  const timedOut = r.error && r.error.code === 'ETIMEDOUT';
  const ok =
    !timedOut &&
    r.status === 0 &&
    summary.tests !== null &&
    summary.fail === 0 &&
    (summary.cancelled || 0) === 0;

  return { ok, timedOut, exitCode: r.status, ...summary, output };
}

/** Keeps the parts of a TAP log that explain failures, within a size budget. */
export function failureExcerpt(output, maxChars = 12_000) {
  const lines = output.split('\n');
  const keep = [];
  lines.forEach((line, i) => {
    if (/^\s*not ok\b/.test(line) || /Error|error:|AssertionError|expected|actual|SyntaxError/.test(line)) {
      keep.push(...lines.slice(Math.max(0, i - 2), i + 25));
    }
  });
  const text = (keep.length ? [...new Set(keep)] : lines.slice(-200)).join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n...[truncated]` : text;
}
