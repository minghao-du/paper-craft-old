import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('rejects the removed worker spawn entry point, including help, without launching a runner', () => {
  for (const args of [
    ['spawn', '81', 'impl'],
    ['spawn', '--help'],
  ]) {
    const result = spawnSync(resolve('pc'), ['worker', ...args], {
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown worker command: spawn');
  }
  const help = spawnSync(resolve('pc'), ['worker', '--help'], { encoding: 'utf8', timeout: 5000 });
  expect(help.status).toBe(0);
  expect(help.stdout).not.toContain('spawn');
});
