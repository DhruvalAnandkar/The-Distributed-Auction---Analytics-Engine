#!/usr/bin/env node
/**
 * @fileoverview Autonomous engineer: implements ONE backlog task per run.
 *
 *   1. Pick the next runnable task from TASKS.json (or --task <id> / TASK_ID).
 *   2. Run the test suite to record a green baseline.
 *   3. Ask the model for a complete change set (source + new tests) as JSON.
 *   4. Guardrails: path policy, protected files, import resolution.
 *   5. Apply, `node --check`, run the FULL suite; require 0 failures and more
 *      tests than the baseline.
 *   6. On failure, revert and feed the errors back to the model (up to 3 tries).
 *   7. On success, mark the task done and write commit message + PR body to
 *      .agent-out/ for the workflow. Nothing is committed by this script.
 *
 * Exit codes: 0 = success / idle / task failed (recorded), 1 = infrastructure error.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createModel, parseModelJson, ModelUnavailableError, resolveModelList } from './llm.mjs';
import {
  validateProposal,
  checkImports,
  normalizeRepoPath,
  sanitizeCommitMessage,
  pickNextTask,
} from './policy.mjs';
import { checkSyntax, runTests, failureExcerpt } from './verify.mjs';

const ROOT = process.env.AGENT_REPO_ROOT
  ? path.resolve(process.env.AGENT_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TASKS_FILE = path.join(ROOT, 'TASKS.json');
const OUT_DIR = path.join(ROOT, '.agent-out');
const CONVENTIONS_FILE = path.join(ROOT, 'docs', 'agent', 'CONVENTIONS.md');
const API_PKG = path.join(ROOT, 'apps', 'api', 'package.json');

const MAX_ATTEMPTS = Number(process.env.AGENT_MAX_ATTEMPTS || 3);
const MAX_RUN_FAILURES = Number(process.env.AGENT_MAX_RUN_FAILURES || 3);
const CONTEXT_CHAR_BUDGET = 160_000; // keeps prompts well inside free-tier token limits
const TASK_ID_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;

// ---------- small helpers ----------

const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');
const abs = (repoPath) => path.join(ROOT, ...repoPath.split('/'));
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const log = (...a) => console.log('[agent]', ...a);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

function setOutput(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = Object.entries(values).map(([k, v]) => `${k}=${String(v).replace(/\n/g, ' ')}`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

/** Task ids that already have an agent/<id> branch on origin (PR awaiting review). */
function tasksInReview() {
  try {
    const out = execFileSync('git', ['ls-remote', '--heads', 'origin', 'agent/*'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return new Set([...out.matchAll(/refs\/heads\/agent\/(\S+)/g)].map((m) => m[1]));
  } catch {
    return new Set();
  }
}

function allowedPackages() {
  const pkg = readJson(API_PKG);
  return new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]);
}

/** Installs npm packages the task explicitly declares (and only those). */
function installTaskDependencies(task) {
  const missing = (task.dependencies || []).filter((d) => !allowedPackages().has(d.replace(/@[^@/]*$/, '')));
  if (!missing.length) return [];
  log(`installing task dependencies: ${missing.join(', ')}`);
  // --ignore-scripts: never run third-party install hooks inside the agent job.
  execFileSync('npm', ['install', ...missing, '--workspace=apps/api', '--no-audit', '--no-fund', '--ignore-scripts'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  return missing;
}

// ---------- prompt ----------

function buildContext(task) {
  const files = [
    ...walk(path.join(ROOT, 'apps', 'api', 'src')),
    ...walk(path.join(ROOT, 'apps', 'api', 'test')),
    API_PKG,
    ...(task.context || []).map(abs),
  ];
  let budget = CONTEXT_CHAR_BUDGET;
  const parts = [];
  for (const f of [...new Set(files)]) {
    if (!fs.existsSync(f)) continue;
    const content = fs.readFileSync(f, 'utf8');
    if (content.length > budget) continue;
    budget -= content.length;
    parts.push(`<file path="${rel(f)}">\n${content}\n</file>`);
  }
  return parts.join('\n\n');
}

function buildPrompt({ task, tasks, previousFailure }) {
  const conventions = fs.existsSync(CONVENTIONS_FILE) ? fs.readFileSync(CONVENTIONS_FILE, 'utf8') : '';
  const completed = tasks
    .filter((t) => t.status === 'done')
    .map((t) => `- ${t.id}: ${t.title}`)
    .join('\n');

  return `You are a senior backend engineer working autonomously on an Express 5 + PostgreSQL
auction platform (Node 22, ESM). Implement exactly ONE backlog task, production quality,
with tests. Your output is applied to the repo and verified automatically; if the full test
suite does not pass, your change is discarded.

# Project conventions (follow strictly)
${conventions}

# Already completed tasks
${completed || '(none)'}

# Your task
${JSON.stringify(
  {
    id: task.id,
    title: task.title,
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    scope: task.scope,
    dependencies: task.dependencies || [],
  },
  null,
  2
)}

# Current repository files
${buildContext(task)}

# Output contract
Respond with ONE JSON object and nothing else:
{
  "summary": "2-4 sentences: what you built and key design decisions",
  "commitMessage": "Conventional Commit subject, e.g. feat(auth): add JWT login endpoint",
  "files": [ { "path": "apps/api/src/...", "content": "<COMPLETE file content>" } ],
  "notes": "optional: follow-ups, limitations, migrations a human must run"
}
Rules:
- "content" is the ENTIRE file, never a diff or a fragment. Include every file you create or change.
- Add at least one NEW test file apps/api/test/<feature>.test.js covering success AND failure paths.
- Never modify existing files under apps/api/test/ (including helpers). Existing tests must keep passing.
- Only import packages listed in apps/api/package.json, the task's "dependencies", or node: built-ins.
- Relative imports must include the .js extension.
${
  previousFailure
    ? `
# Your previous attempt FAILED verification — fix it
Errors:
${previousFailure.errors.join('\n')}

${previousFailure.testExcerpt ? `Test output (excerpt):\n${previousFailure.testExcerpt}` : ''}

Files you proposed last time:
${previousFailure.files.map((f) => `<file path="${f.path}">\n${f.content}\n</file>`).join('\n\n')}

Return a corrected, complete change set in the same JSON format.`
    : ''
}`;
}

// ---------- apply / revert ----------

function applyFiles(files) {
  const snapshot = files.map((f) => {
    const target = abs(f.path);
    return { target, existed: fs.existsSync(target), before: fs.existsSync(target) ? fs.readFileSync(target) : null };
  });
  for (const f of files) {
    fs.mkdirSync(path.dirname(abs(f.path)), { recursive: true });
    fs.writeFileSync(abs(f.path), f.content.endsWith('\n') ? f.content : `${f.content}\n`);
  }
  return function revert() {
    for (const s of snapshot) {
      if (s.existed) fs.writeFileSync(s.target, s.before);
      else fs.rmSync(s.target, { force: true });
    }
  };
}

// ---------- one attempt ----------

async function attempt({ model, task, tasks, baseline, previousFailure, existingFiles }) {
  const raw = await model.generate(buildPrompt({ task, tasks, previousFailure }));

  let proposal;
  try {
    proposal = parseModelJson(raw);
  } catch (e) {
    return { ok: false, errors: [e.message], files: [] };
  }

  const policyErrors = validateProposal(proposal, { task, existingFiles });
  const files = (proposal.files || [])
    .map((f) => ({ path: normalizeRepoPath(f && f.path), content: f && f.content }))
    .filter((f) => f.path && typeof f.content === 'string');
  const proposed = new Set(files.map((f) => f.path));
  const importErrors = checkImports(files, {
    allowedPackages: allowedPackages(),
    fileExists: (p) => proposed.has(p) || existingFiles.has(p),
  });
  // Report every static problem at once so the repair attempt can fix them all.
  if (policyErrors.length || importErrors.length) {
    return { ok: false, errors: [...policyErrors, ...importErrors], files };
  }

  const revert = applyFiles(files);

  const syntaxErrors = checkSyntax(ROOT, files.map((f) => f.path));
  if (syntaxErrors.length) {
    revert();
    return { ok: false, errors: syntaxErrors, files };
  }

  const tests = runTests(ROOT);
  const errors = [];
  if (!tests.ok) {
    errors.push(
      tests.timedOut
        ? 'Test suite timed out (a test may be hanging on a real DB connection or an open handle).'
        : `Test suite failed: ${tests.fail ?? '?'} failing of ${tests.tests ?? '?'} tests (exit ${tests.exitCode}).`
    );
  } else if (tests.tests <= baseline.tests) {
    errors.push(`No new tests ran (baseline ${baseline.tests}, now ${tests.tests}). Add real test cases.`);
  }

  if (errors.length) {
    revert();
    return { ok: false, errors, files, testExcerpt: failureExcerpt(tests.output) };
  }

  return { ok: true, proposal, files, tests };
}

// ---------- reporting ----------

function writeSuccess({ task, result, attempts, baseline, model, installed }) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const subject = sanitizeCommitMessage(result.proposal.commitMessage, task);
  const body = [
    subject,
    '',
    String(result.proposal.summary || '').trim(),
    '',
    `Task: ${task.id}`,
    `Verified: ${result.tests.pass}/${result.tests.tests} tests passing (baseline ${baseline.tests}), attempt ${attempts}/${MAX_ATTEMPTS}`,
    `Generated-by: autonomous-engineer agent (${model.name})`,
  ].join('\n');
  fs.writeFileSync(path.join(OUT_DIR, 'commit-message.txt'), `${body}\n`);

  // Exact list of paths the workflow is allowed to stage (never `git add -A`).
  const stage = [...result.files.map((f) => f.path), 'TASKS.json'];
  if (installed.length) stage.push('apps/api/package.json', 'package-lock.json');
  fs.writeFileSync(path.join(OUT_DIR, 'files.txt'), `${stage.join('\n')}\n`);

  const pr = [
    `## ${task.title}`,
    '',
    `> 🤖 Implemented autonomously by the repo's engineering agent (\`${model.name}\`) and verified in CI before this PR was opened.`,
    '',
    '### Summary',
    String(result.proposal.summary || '').trim(),
    '',
    '### Acceptance criteria',
    ...(task.acceptanceCriteria || []).map((c) => `- [x] ${c}`),
    '',
    '### Files',
    ...result.files.map((f) => `- \`${f.path}\``),
    ...(installed.length ? ['', `### New dependencies`, ...installed.map((d) => `- \`${d}\``)] : []),
    '',
    '### Verification',
    '| Check | Result |',
    '|---|---|',
    '| Path policy & protected files | ✅ |',
    '| Import resolution (no hallucinated modules) | ✅ |',
    '| `node --check` on changed files | ✅ |',
    `| Full test suite | ✅ ${result.tests.pass}/${result.tests.tests} passing |`,
    `| New tests added | ✅ +${result.tests.tests - baseline.tests} |`,
    `| Attempts needed | ${attempts}/${MAX_ATTEMPTS} |`,
    ...(result.proposal.notes ? ['', '### Notes from the agent', String(result.proposal.notes).trim()] : []),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(OUT_DIR, 'pr-body.md'), pr);

  fs.writeFileSync(
    path.join(OUT_DIR, 'result.json'),
    JSON.stringify({ status: 'success', task: task.id, files: result.files.map((f) => f.path), tests: result.tests.tests }, null, 2)
  );
  setOutput({ status: 'success', task_id: task.id, branch: `agent/${task.id}`, title: subject });
}

function writeFailure({ task, history }) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const report = [
    `# Agent failed: ${task.id}`,
    '',
    ...history.flatMap((h, i) => [
      `## Attempt ${i + 1}`,
      ...h.errors.map((e) => `- ${e}`),
      h.testExcerpt ? `\n\`\`\`\n${h.testExcerpt.slice(0, 4000)}\n\`\`\`` : '',
      '',
    ]),
  ].join('\n');
  fs.writeFileSync(path.join(OUT_DIR, 'failure.md'), report);
  setOutput({ status: 'failed', task_id: task.id });
}

// ---------- main ----------

async function main() {
  const tasksDoc = readJson(TASKS_FILE);
  const tasks = tasksDoc.tasks;

  const requested = argValue('--task') || process.env.TASK_ID || '';
  const task = requested
    ? tasks.find((t) => t.id === requested)
    : pickNextTask(tasks, { inReview: tasksInReview(), maxRunFailures: MAX_RUN_FAILURES });

  if (task && !TASK_ID_RE.test(task.id)) {
    throw new Error(`Task id "${task.id}" is invalid (use lowercase letters, digits and dashes).`);
  }
  if (task && (task.dependencies || []).some((d) => !/^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*(@[\w.^~-]+)?$/.test(d))) {
    throw new Error(`Task ${task.id} lists an invalid npm dependency name.`);
  }

  if (!task) {
    log(requested ? `task "${requested}" not found` : 'no runnable task — backlog empty, blocked, or awaiting review');
    setOutput({ status: 'idle' });
    return 0;
  }
  log(`task: ${task.id} — ${task.title}`);

  const model = createModel({
    apiKey: process.env.GEMINI_API_KEY,
    modelNames: resolveModelList(process.env.GEMINI_MODEL),
    fixtureDir: process.env.AGENT_FIXTURE_DIR,
  });

  const baseline = runTests(ROOT);
  if (!baseline.ok) {
    console.error(failureExcerpt(baseline.output));
    throw new Error('Baseline test suite is failing on main; refusing to build on a red build.');
  }
  log(`baseline: ${baseline.tests} tests passing`);

  const installed = installTaskDependencies(task);
  const existingFiles = new Set(walk(ROOT).map(rel));

  const history = [];
  for (let n = 1; n <= MAX_ATTEMPTS; n += 1) {
    log(`attempt ${n}/${MAX_ATTEMPTS}`);
    const result = await attempt({
      model,
      task,
      tasks,
      baseline,
      previousFailure: history[history.length - 1],
      existingFiles,
    });

    if (result.ok) {
      log(`verified: ${result.tests.pass}/${result.tests.tests} tests passing`);
      Object.assign(task, {
        status: 'done',
        completedAt: new Date().toISOString(),
        attempts: (task.attempts || 0) + 1,
        files: result.files.map((f) => f.path),
      });
      delete task.lastError;
      fs.writeFileSync(TASKS_FILE, `${JSON.stringify(tasksDoc, null, 2)}\n`);
      writeSuccess({ task, result, attempts: n, baseline, model, installed });
      return 0;
    }

    log(`attempt ${n} rejected:\n  - ${result.errors.join('\n  - ')}`);
    history.push(result);
  }

  // All attempts failed: leave code untouched, record the failure on the task.
  if (installed.length) {
    execFileSync('git', ['checkout', '--', 'apps/api/package.json', 'package-lock.json'], { cwd: ROOT });
  }
  task.attempts = (task.attempts || 0) + 1;
  task.lastError = history[history.length - 1].errors[0].slice(0, 300);
  if (task.attempts >= MAX_RUN_FAILURES) task.status = 'blocked';
  fs.writeFileSync(TASKS_FILE, `${JSON.stringify(tasksDoc, null, 2)}\n`);
  writeFailure({ task, history });
  log(`giving up on ${task.id} for this run (${task.attempts}/${MAX_RUN_FAILURES} runs failed)`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`[agent] ${error instanceof ModelUnavailableError ? 'model unavailable' : 'error'}: ${error.message}`);
    setOutput({ status: 'error' });
    process.exit(1);
  });
