import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  globToRegExp,
  normalizeRepoPath,
  validateProposal,
  checkImports,
  extractImports,
  sanitizeCommitMessage,
  pickNextTask,
} from './policy.mjs';

const task = { id: 't', title: 'Do a thing' };
const existing = new Set(['apps/api/src/app.js', 'apps/api/test/health.test.js', 'apps/api/test/helpers/fakeDb.js']);
const newTest = { path: 'apps/api/test/thing.test.js', content: 'ok' };

test('globToRegExp handles ** and *', () => {
  assert.ok(globToRegExp('apps/api/src/**').test('apps/api/src/a/b/c.js'));
  assert.ok(globToRegExp('**/package.json').test('package.json'));
  assert.ok(globToRegExp('**/package.json').test('apps/api/package.json'));
  assert.ok(!globToRegExp('apps/api/src/*.js').test('apps/api/src/a/b.js'));
});

test('normalizeRepoPath rejects escapes and absolute paths', () => {
  assert.equal(normalizeRepoPath('./apps/api/src/x.js'), 'apps/api/src/x.js');
  assert.equal(normalizeRepoPath('../etc/passwd'), null);
  assert.equal(normalizeRepoPath('apps/../../x'), null);
  assert.equal(normalizeRepoPath('/etc/passwd'), null);
});

test('validateProposal accepts an in-scope change with a new test', () => {
  const errors = validateProposal(
    { files: [{ path: 'apps/api/src/x.js', content: 'export {}' }, newTest] },
    { task, existingFiles: existing }
  );
  assert.deepEqual(errors, []);
});

test('validateProposal blocks protected paths, out-of-scope files and missing tests', () => {
  const errors = validateProposal(
    {
      files: [
        { path: '.github/workflows/x.yml', content: 'x' },
        { path: 'apps/api/package.json', content: '{}' },
        { path: 'README.md', content: 'x' },
      ],
    },
    { task, existingFiles: existing }
  );
  assert.ok(errors.some((e) => e.includes('.github/workflows/x.yml') && e.includes('protected')));
  assert.ok(errors.some((e) => e.includes('apps/api/package.json') && e.includes('protected')));
  assert.ok(errors.some((e) => e.includes('README.md') && e.includes('scope')));
  assert.ok(errors.some((e) => e.includes('NEW test file')));
});

test('validateProposal makes existing tests read-only unless the task allows it', () => {
  const proposal = { files: [{ path: 'apps/api/test/health.test.js', content: 'weakened' }, newTest] };
  assert.ok(validateProposal(proposal, { task, existingFiles: existing }).some((e) => e.includes('read-only')));
  assert.deepEqual(validateProposal(proposal, { task: { ...task, allowTestEdits: true }, existingFiles: existing }), []);
});

test('extractImports finds static, re-export and dynamic imports', () => {
  const src = `import a from 'express';\nimport { b,\n c } from './x.js';\nimport 'dotenv/config';\nexport * from './y.js';\nconst z = await import('node:fs');`;
  assert.deepEqual(extractImports(src).sort(), ['./x.js', './y.js', 'dotenv/config', 'express', 'node:fs'].sort());
});

test('checkImports catches hallucinated packages, missing files and missing extensions', () => {
  const files = [
    {
      path: 'apps/api/src/routes/a.js',
      content: `import express from 'express';\nimport { z } from 'zod';\nimport x from '../lib/x';\nimport y from '../lib/y.js';\nimport crypto from 'node:crypto';\nimport fs from 'fs';\nimport { test } from 'node:test';`,
    },
  ];
  const errors = checkImports(files, {
    allowedPackages: new Set(['express']),
    fileExists: () => false,
  });
  assert.equal(errors.length, 3);
  assert.ok(errors.some((e) => e.includes('"zod"')));
  assert.ok(errors.some((e) => e.includes('.js extension')));
  assert.ok(errors.some((e) => e.includes('apps/api/src/lib/y.js does not exist')));
});

test('checkImports rejects require() in ESM files', () => {
  const errors = checkImports([{ path: 'apps/api/src/a.js', content: "const x = require('express');" }], {
    allowedPackages: new Set(['express']),
    fileExists: () => true,
  });
  assert.ok(errors.some((e) => e.includes('require()')));
});

test('sanitizeCommitMessage keeps conventional commits and replaces junk', () => {
  assert.equal(sanitizeCommitMessage('feat(auth): add login endpoint', task), 'feat(auth): add login endpoint');
  assert.equal(sanitizeCommitMessage('updated stuff', task), 'feat(api): Do a thing');
});

test('pickNextTask respects dependencies, review state and retry budget', () => {
  const tasks = [
    { id: 'a', status: 'done' },
    { id: 'b', status: 'pending', dependsOn: ['c'] },
    { id: 'c', status: 'pending', attempts: 3 },
    { id: 'd', status: 'pending', dependsOn: ['a'] },
    { id: 'e', status: 'pending' },
  ];
  assert.equal(pickNextTask(tasks).id, 'd');
  assert.equal(pickNextTask(tasks, { inReview: new Set(['d']) }).id, 'e');
  assert.equal(pickNextTask([{ id: 'x', status: 'blocked' }]), null);
});
