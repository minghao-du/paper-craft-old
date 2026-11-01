/** Repository contracts for the Run-scoped public vocabulary. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const allowed = new Set([
  'docs/adr/0002-run-scoped-orchestrator.md',
  'docs/adr/0002-run-scoped-orchestrator.zh.md',
  'docs/adr/0002-run-scoped-orchestrator.i18n.yaml',
  'tests/workflow/vocabulary.test.ts',
]);
const violations = (files: { path: string; content: string }[]) =>
  files.filter(({ path, content }) => !allowed.has(path) && /conductor/i.test(path + content));

it('rejects retired vocabulary in tracked files while allowing the decision record', () => {
  expect(violations([{ path: 'planted.md', content: 'Conductor' }])).toHaveLength(1);
  expect(
    violations([{ path: 'docs/adr/0002-run-scoped-orchestrator.md', content: 'Conductor' }]),
  ).toEqual([]);
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((path) => path && existsSync(resolve(root, path)));
  expect(
    violations(paths.map((path) => ({ path, content: readFileSync(resolve(root, path), 'utf8') }))),
  ).toEqual([]);
});
