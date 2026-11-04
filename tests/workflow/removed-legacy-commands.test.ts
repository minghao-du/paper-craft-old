import { spawnSync } from 'node:child_process';
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
