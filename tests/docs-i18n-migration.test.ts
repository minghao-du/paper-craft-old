import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// Protect the shipped second migration batch through the public aggregate gate.
// Existing temporary-repository tests cover new-document and backlog invariants.
test('the second migration batch is active under the aggregate documentation gate', () => {
  const result = spawnSync('pnpm', ['docs:check'], {
    encoding: 'utf8',
    timeout: 20000,
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const list = spawnSync(
    process.execPath,
    [resolve('node_modules/tsx/dist/cli.mjs'), resolve('scripts/docs/docs-i18n.ts'), 'list'],
    { encoding: 'utf8', timeout: 10000 },
  );
  for (const file of ['CONSTITUTION.md', 'DESIGN.md', 'GLOSSARY.md']) {
    expect(list.stdout).toContain(`ok ${file}`);
    expect(list.stdout).not.toContain(`backlog ${file}`);
  }
}, 30000);
