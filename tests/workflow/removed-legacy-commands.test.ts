import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const pc = resolve('pc');

it('does not list removed root commands in help output', () => {
  const result = spawnSync(pc, ['--help'], { encoding: 'utf8', timeout: 10000 });
  expect(result.status).toBe(0);
  const lines = result.stdout.split('\n');
  const commandLines = lines.filter((line) => /^\s+(status|pr|worker|run)\b/.test(line));
  expect(commandLines).toEqual([]);
}, 20000);

it.each(['status', 'pr', 'worker', 'run'])('rejects removed root command %s with unknown command error', (cmd) => {
  const result = spawnSync(pc, [cmd], { encoding: 'utf8', timeout: 10000 });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(`error: unknown command '${cmd}'`);
}, 20000);

it('rejects removed orchestrator finalize-epic command with unknown command error', () => {
  const result = spawnSync(pc, ['workflow', 'orchestrator', 'finalize-epic'], { encoding: 'utf8', timeout: 10000 });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("error: unknown command 'finalize-epic'");
}, 20000);

it('confirms retired driver modules are absent from the filesystem', () => {
  const retiredPaths = [
    'packages/core/src/workflow/delivery/issue-driver.ts',
    'packages/core/src/workflow/delivery/epic-driver.ts',
    'packages/core/src/workflow/delivery/epic-completion.ts',
    'packages/core/src/workflow/delivery/postmerge.ts',
    'packages/cli/src/workflow/epic-completion.ts',
  ];
  for (const relPath of retiredPaths) {
    expect(existsSync(resolve(relPath))).toBe(false);
  }
});

it('confirms retired driver modules are absent from package exports', () => {
  const pkg = JSON.parse(readFileSync(resolve('packages/core/package.json'), 'utf8')) as {
    exports?: Record<string, unknown>;
  };
  const exportKeys = Object.keys(pkg.exports ?? {});
  expect(exportKeys).not.toContain('./workflow/issue-driver');
  expect(exportKeys).not.toContain('./workflow/epic-driver');
  expect(exportKeys).not.toContain('./workflow/epic-completion');
  expect(exportKeys).not.toContain('./workflow/postmerge');
});
