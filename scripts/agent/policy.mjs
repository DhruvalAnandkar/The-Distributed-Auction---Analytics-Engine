/**
 * @fileoverview Guardrails applied to every change set the model proposes,
 * BEFORE anything touches the working tree. Pure functions, unit tested in
 * policy.test.mjs.
 */

import path from 'node:path';
import { builtinModules } from 'node:module';

export const DEFAULT_SCOPE = ['apps/api/src/**', 'apps/api/test/**'];

/** Paths the agent may never write, whatever a task's scope says. */
export const FORBIDDEN = [
  '.github/**',
  'scripts/**',
  '**/package.json',
  '**/package-lock.json',
  'TASKS.json',
  '**/.env',
  '**/.env.*',
  '**/node_modules/**',
  '.git/**',
];

export const MAX_FILES = 12;
export const MAX_FILE_CHARS = 60_000;

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

/** Minimal glob -> RegExp supporting `**`, `*` and `?`. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more directories; trailing `**` matches anything.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export const matchesAny = (filePath, globs) => globs.some((g) => globToRegExp(g).test(filePath));

/** Returns a clean repo-relative POSIX path, or null if it escapes the repo. */
export function normalizeRepoPath(p) {
  if (typeof p !== 'string' || p.trim() === '') return null;
  if (path.isAbsolute(p) || /^[a-zA-Z]:/.test(p)) return null;
  const normalized = path.posix.normalize(p.replace(/\\/g, '/'));
  if (normalized.startsWith('../') || normalized === '..' || normalized.startsWith('/')) return null;
  return normalized.replace(/^\.\//, '');
}

const isTestFile = (p) => /^apps\/api\/test\/.+\.test\.js$/.test(p);

/**
 * Validates the shape and paths of a proposal.
 *
 * @param {{ files: Array<{path: string, content: string}> }} proposal
 * @param {Object} ctx
 * @param {Object} ctx.task - task from TASKS.json
 * @param {Set<string>} ctx.existingFiles - repo-relative paths that exist today
 * @returns {string[]} human-readable errors (empty = ok)
 */
export function validateProposal(proposal, { task, existingFiles }) {
  const errors = [];

  if (!proposal || !Array.isArray(proposal.files) || proposal.files.length === 0) {
    return ['Response must contain a non-empty "files" array.'];
  }
  if (proposal.files.length > MAX_FILES) {
    errors.push(`Too many files (${proposal.files.length}); max is ${MAX_FILES}. Split the work.`);
  }

  const scope = task.scope && task.scope.length ? task.scope : DEFAULT_SCOPE;
  const seen = new Set();
  let addsNewTest = false;

  for (const file of proposal.files) {
    const p = normalizeRepoPath(file && file.path);
    if (!p) {
      errors.push(`Invalid path ${JSON.stringify(file && file.path)}.`);
      continue;
    }
    if (seen.has(p)) errors.push(`${p} appears more than once.`);
    seen.add(p);

    if (typeof file.content !== 'string' || file.content.trim() === '') {
      errors.push(`${p}: content must be the complete, non-empty file.`);
    } else if (file.content.length > MAX_FILE_CHARS) {
      errors.push(`${p}: file too large (${file.content.length} chars).`);
    }

    if (matchesAny(p, FORBIDDEN)) {
      errors.push(`${p}: this path is protected and may not be written by the agent.`);
    } else if (!matchesAny(p, scope)) {
      errors.push(`${p}: outside this task's scope (${scope.join(', ')}).`);
    }

    const isExistingTestCode = p.startsWith('apps/api/test/') && existingFiles.has(p);
    if (isExistingTestCode && !task.allowTestEdits) {
      errors.push(
        `${p}: existing tests and test helpers are read-only. Put new tests in a NEW *.test.js file.`
      );
    }
    if (isTestFile(p) && !existingFiles.has(p)) addsNewTest = true;
  }

  if (!addsNewTest) {
    errors.push('Every task must add at least one NEW test file at apps/api/test/<name>.test.js.');
  }

  return errors;
}

/** Extracts module specifiers from ESM source (static, re-export and dynamic). */
export function extractImports(source) {
  const specs = new Set();
  const patterns = [
    /\bimport\s+(?:[^'";]*?\s*from\s*)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:\*(?:\s+as\s+\w+)?|\{[^'";]*?\})\s*from\s*['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) specs.add(m[1]);
  }
  return [...specs];
}

const packageNameOf = (spec) =>
  spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];

/**
 * Catches hallucinated imports before anything runs: unknown npm packages,
 * relative imports without a `.js` extension (ESM requires it), and relative
 * imports pointing at files that will not exist.
 *
 * @param {Array<{path: string, content: string}>} files - normalized paths
 * @param {Object} ctx
 * @param {Set<string>} ctx.allowedPackages
 * @param {(repoPath: string) => boolean} ctx.fileExists - existence in the final tree
 * @returns {string[]} errors
 */
export function checkImports(files, { allowedPackages, fileExists }) {
  const errors = [];
  for (const file of files) {
    if (!file.path.endsWith('.js')) continue;

    if (/\brequire\(/.test(file.content)) {
      errors.push(`${file.path}: uses require(); this workspace is ESM — use import.`);
    }

    for (const spec of extractImports(file.content)) {
      if (spec.startsWith('.') || spec.startsWith('/')) {
        if (!/\.(js|json)$/.test(spec)) {
          errors.push(`${file.path}: relative import "${spec}" must include the .js extension.`);
          continue;
        }
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), spec));
        if (!fileExists(target)) {
          errors.push(`${file.path}: imports "${spec}" but ${target} does not exist.`);
        }
      } else if (!spec.startsWith('node:') && !BUILTINS.has(spec) && !BUILTINS.has(packageNameOf(spec))) {
        const pkg = packageNameOf(spec);
        if (!allowedPackages.has(pkg)) {
          errors.push(
            `${file.path}: imports package "${pkg}", which is not installed. Allowed: ${[
              ...allowedPackages,
            ].join(', ')}, plus node: built-ins.`
          );
        }
      }
    }
  }
  return errors;
}

/** Keeps commit messages in Conventional Commits form. */
export function sanitizeCommitMessage(message, task) {
  const firstLine = String(message || '').split('\n')[0].trim();
  if (/^(feat|fix|refactor|test|perf|chore|docs)(\([a-z0-9-]+\))?: .{5,72}$/.test(firstLine)) {
    return firstLine;
  }
  return `feat(api): ${task.title}`.slice(0, 80);
}

/** Picks the next runnable task: pending, dependencies done, not in review, not over the retry budget. */
export function pickNextTask(tasks, { inReview = new Set(), maxRunFailures = 3 } = {}) {
  const done = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
  return (
    tasks.find(
      (t) =>
        t.status === 'pending' &&
        !inReview.has(t.id) &&
        (t.attempts || 0) < maxRunFailures &&
        (t.dependsOn || []).every((dep) => done.has(dep))
    ) || null
  );
}
