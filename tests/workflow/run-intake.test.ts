import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('persists transparent runner and conversational requirements through CLI intake', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-intake-'));
  const pc = resolve('pc');
  const invoke = (...args: string[]) => JSON.parse(execFileSync(pc, args, { encoding: 'utf8' }));
  try {
    const run = invoke(
      'run',
      'create',
      '--root',
      root,
      '--issue',
      '79',
      '--runner',
      'claude -p',
      '--instructions',
      'Only edit scripts',
      '--instructions',
      'Check paths with spaces',
    );
    const inspected = invoke('run', 'inspect', run.run_id, '--root', root);
    expect(inspected).toEqual(run);
    expect(inspected).toMatchObject({
      issue_id: 79,
      runner_cmd: 'claude -p',
      custom_instructions: ['Only edit scripts', 'Check paths with spaces'],
    });
    expect(
      JSON.parse(
        readFileSync(join(root, '.runtime', 'default', 'runs', run.run_id, 'run.json'), 'utf8'),
      ),
    ).toEqual(run);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
