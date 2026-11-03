/**
 * Chooses which repository files the model sees for a task. Source files,
 * package.json and test helpers are always included; then task-related tests,
 * two small example tests, then the rest while the budget allows. Tests left
 * out are listed with their titles so the model knows they exist.
 */
const STOP_WORDS = new Set(['the','and','for','with','add','api','get','post','patch','delete','from','into','endpoint','endpoints','middleware','new','list','own','test','tests','js','src']);

export function taskKeywords(task) {
  const text = [task.id, task.title, ...(task.context || [])].join(' ').toLowerCase();
  const words = text.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  return [...new Set(words.flatMap((w) => [w, w.replace(/s$/, '')]))];
}

export function testTitles(source) {
  return [...source.matchAll(/\btest\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]).slice(0, 25);
}

export function selectContext({ files, task, budget }) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const isTest = (p) => /^apps\/api\/test\/.+\.test\.js$/.test(p);
  const isSrc = (p) => p.startsWith('apps/api/src/');
  const isHelper = (p) => p.startsWith('apps/api/test/helpers/');
  const keywords = taskKeywords(task);
  const tests = files.filter((f) => isTest(f.path));
  const related = tests.filter((f) => keywords.some((k) => f.path.split('/').pop().toLowerCase().includes(k)));
  const examples = [...tests].sort((a, b) => a.content.length - b.content.length).slice(0, 2);
  const ordered = [
    ...files.filter((f) => isSrc(f.path)),
    ...files.filter((f) => f.path === 'apps/api/package.json' || isHelper(f.path)),
    ...(task.context || []).map((p) => byPath.get(p)).filter(Boolean),
    ...related, ...examples, ...tests,
  ];
  const included = []; const seen = new Set(); const parts = []; let remaining = budget;
  for (const f of ordered) {
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    const mustHave = isSrc(f.path) || isHelper(f.path) || f.path === 'apps/api/package.json';
    if (!mustHave && f.content.length > remaining) continue;
    remaining -= f.content.length;
    included.push(f.path);
    parts.push(`<file path="${f.path}">\n${f.content}\n</file>`);
  }
  const omitted = tests.filter((f) => !included.includes(f.path));
  if (omitted.length) {
    const index = omitted.map((f) => `- ${f.path}\n${testTitles(f.content).map((t) => `    • ${t}`).join('\n')}`).join('\n');
    parts.push(`<omitted-tests note="Not shown in full to save space. They exist, they must keep passing, and you must not modify them.">\n${index}\n</omitted-tests>`);
  }
  return { text: parts.join('\n\n'), included, omitted: omitted.map((f) => f.path) };
}
