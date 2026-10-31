import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('rejects autonomous issue delivery before consulting configuration or launching workers', () => {
  const result = spawnSync(resolve('pc'), ['workflow', 'orchestrator', 'issue', '79'], {
    encoding: 'utf8',
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('deprecated');
  expect(result.stderr).toContain('pc run create');
  expect(result.stderr).toContain('pc-orchestrator');
}, 10000);
