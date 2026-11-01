import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('rejects retired dispatch entry points before launching work', () => {
  for (const args of [
    ['orchestrator', 'issue', '79'],
    ['intent', 'write', '79'],
  ]) {
    const result = spawnSync(resolve('pc'), ['workflow', ...args], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unknown command');
  }
}, 10000);
