import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { readDashboardFleet } from '../../packages/core/src/workflow/dashboard.js';
import { readTaskLog } from '../../packages/dashboard/src/logs.js';

// Real CLI intake + dispatch files: missing legacy state must not hide current workers.
test('Dashboard and worker status discover the same dispatches and safely expose worker logs', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dashboard-workers-')));
  try {
    mkdirSync(join(root, 'pool'));
    const config = join(root, '.epic-config.json');
    writeFileSync(config, JSON.stringify({ clone_root: 'pool', local_worktrees: true }));
    const invoke = (...args: string[]) =>
      JSON.parse(execFileSync(resolve('pc'), [...args, '--root', root], { encoding: 'utf8' }));
    const run = invoke('run', 'create', '--issue', '79', '--runner', 'fake');
    for (const id of ['active', 'done']) {
      const dir = join(root, '.runtime/default/runs', run.run_id, 'dispatches', id);
      const worktree = join(root, '.runtime/default/worktrees', id);
      mkdirSync(dir, { recursive: true });
      mkdirSync(worktree, { recursive: true });
      writeFileSync(
        join(dir, 'dispatch.json'),
        JSON.stringify({
          dispatch_id: id,
          run_id: run.run_id,
          issue_id: 80,
          role: 'worker',
          worktree,
        }),
      );
      writeFileSync(join(dir, 'worker.log'), 'Checking cluster\nAuthorization: Bearer hidden\n');
      if (id === 'done')
        writeFileSync(join(dir, 'RECEIPT.md'), 'outcome: succeeded\nsummary: Planned\n');
    }
    const fleet = await readDashboardFleet({ id: 'test', config });
    expect(fleet.error).toBeUndefined();
    expect(fleet.tasks).toHaveLength(2);
    expect(fleet.tasks.every((t) => !t.error)).toBe(true);
    const status = invoke('worker', 'status', run.run_id);
    expect(fleet.tasks.map((t) => [t.dispatchId, t.phase])).toEqual(
      status.attempts.map((a: { dispatch_id: string; state: string }) => [a.dispatch_id, a.state]),
    );
    const task = fleet.tasks.find((t) => t.dispatchId === 'active')!;
    const execute = async () => {
      throw new Error('Unexpected process launch');
    };
    expect(await readTaskLog(config, task, 'worklog', 0, execute)).toMatchObject({
      state: 'read',
      text: 'Checking cluster\n[sensitive line omitted]\n',
    });
    const log = join(task.source, '..', 'worker.log');
    rmSync(log);
    symlinkSync(config, log);
    expect(await readTaskLog(config, task, 'worklog', 0, execute)).toMatchObject({
      state: 'error',
    });
    writeFileSync(task.source, '{broken');
    expect((await readDashboardFleet({ id: 'test', config })).error).toBeTruthy();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
