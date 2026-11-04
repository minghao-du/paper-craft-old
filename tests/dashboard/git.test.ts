import { test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboard } from '../../packages/dashboard/src/server.js';
import { loadFleetConfig } from '../../packages/core/src/workflow/fleet/fleet-config.js';
import { updateRunRegistry, home } from '../../packages/core/src/workflow/run/run-driver.js';

test('Git evidence uses cached refs and retains attributed stale values after failure without changing checkouts', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dashboard-git-')));
  let dashboard;
  const git = (dir: string, ...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  try {
    const origin = join(root, 'origin');
    mkdirSync(origin);
    git(origin, 'init', '-b', 'main');
    git(origin, 'config', 'user.email', 'fixture@example.test');
    git(origin, 'config', 'user.name', 'Fixture');
    writeFileSync(join(origin, 'file.txt'), 'base');
    git(origin, 'add', '.');
    git(origin, 'commit', '-m', 'base');
    const project = join(root, 'project');
    execFileSync('git', ['clone', '-q', origin, project]);
    const pool = join(project, 'pool');
    mkdirSync(pool);
    const worker = join(pool, 'worker');
    execFileSync('git', ['clone', '-q', origin, worker]);
    git(worker, 'checkout', '-b', 'work');
    writeFileSync(join(worker, 'file.txt'), 'edited');
    const config = join(project, '.epic-config.json');
    writeFileSync(config, JSON.stringify({ clone_root: 'pool', clone_names: ['worker'] }));
    const before = git(worker, 'status', '--porcelain');
    dashboard = await createDashboard({
      dataDir: join(root, 'data'),
      configs: [config],
      token: 'secret',
      host: '127.0.0.1:7777',
    });
    const read = async () =>
      (
        await dashboard!.app.request('http://127.0.0.1:7777/api/git', {
          headers: { host: '127.0.0.1:7777', authorization: 'Bearer secret' },
        })
      ).json();
    let evidence = (await read())[0];
    expect(evidence.value.slots[0]).toMatchObject({
      name: 'worker',
      branch: 'work',
      dirty: true,
      relation: 'current',
      touched: ['file.txt'],
    });
    expect(evidence.value.occupancy).toBe('unknown');
    expect(evidence.value.scope.remote).toBe('cached');
    expect(await read()).toEqual([evidence]);
    expect(git(worker, 'status', '--porcelain')).toBe(before);
    expect(readFileSync(join(worker, 'file.txt'), 'utf8')).toBe('edited');
    // Current worker spawning uses runtime worktrees, without legacy configured slots.
    const run = { run_id: 'run-79' };
    const dispatch = join(project, '.runtime/default/runs', run.run_id, 'dispatches', 'active');
    const runtimeWorker = join(project, '.runtime/default/worktrees/active');
    mkdirSync(dispatch, { recursive: true });
    mkdirSync(join(project, '.runtime/default/worktrees'), { recursive: true });
    git(project, 'worktree', 'add', '-b', 'runtime-worker', runtimeWorker, 'HEAD');
    writeFileSync(
      join(dispatch, 'dispatch.json'),
      JSON.stringify({
        dispatch_id: 'active',
        run_id: run.run_id,
        issue_id: 80,
        role: 'worker',
        worktree: git(runtimeWorker, 'rev-parse', '--show-toplevel'),
      }),
    );
    writeFileSync(config, JSON.stringify({ clone_root: 'pool', local_worktrees: true }));
    const fleetConfig = loadFleetConfig(config);
    const registryPath = join(home(fleetConfig), 'registry.json');
    updateRunRegistry(fleetConfig, (reg) => {
      reg.runs.push({
        id: run.run_id,
        subject: { repository: 'owner/repo', number: 79, kind: 'issue', title: 't', body: 'b' },
        provider: 'agy',
        policy: { name: 'default', revision: 1 },
        lifecycle: 'running',
        orchestratorId: 'orch-1',
        brief: { path: '', hash: '' },
      });
      reg.resources = [
        { path: runtimeWorker, runId: run.run_id, registry: registryPath },
      ];
    });
    writeFileSync(
      join(runtimeWorker, '.pc-execution-owner'),
      JSON.stringify({ path: runtimeWorker, runId: run.run_id, registry: registryPath }),
    );
    writeFileSync(join(project, '.git', 'info', 'exclude'), '.pc-execution-owner\n');
    writeFileSync(join(runtimeWorker, 'file.txt'), 'runtime edit');
    const runtimeBefore = git(runtimeWorker, 'status', '--porcelain');
    await dashboard.refresh(true);
    evidence = (await read())[0];
    expect(evidence.error).toBeUndefined();
    expect(evidence.stale).toBe(false);
    expect(evidence.value.slots).toEqual([
      expect.objectContaining({
        name: `${run.run_id}/active`,
        branch: 'runtime-worker',
        dirty: true,
        touched: ['file.txt'],
        relation: 'current',
      }),
    ]);
    expect(git(runtimeWorker, 'status', '--porcelain')).toBe(runtimeBefore);
    rmSync(config);
    await dashboard.refresh(true);
    evidence = (await read())[0];
    expect(evidence).toMatchObject({
      stale: true,
      value: { slots: [{ branch: 'runtime-worker' }] },
    });
    expect(evidence.error).toBeTruthy();
    expect(evidence.lastSuccessAt).toBeTruthy();
  } finally {
    dashboard?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
