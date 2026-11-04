import { execFileSync } from 'node:child_process';
import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboard } from '../../packages/dashboard/src/server.js';
import { updateRunRegistry } from '@paper-craft/core/workflow/run-driver';
import { loadFleetConfig } from '@paper-craft/core/workflow/fleet-config';

test('runtime HTTP evidence attributes panes by physical directory, keeps shell occupancy unknown and retains stale successes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-'));
  let service;
  try {
    mkdirSync(join(root, 'pool', 'worker'), { recursive: true });
    const config = join(root, '.epic-config.json');
    writeFileSync(config, JSON.stringify({ clone_root: 'pool', clone_names: ['worker'] }));
    const fleetConfig = loadFleetConfig(config);
    const briefPath = join(root, 'brief.md');
    writeFileSync(briefPath, '# Brief');
    updateRunRegistry(fleetConfig, (registry) => {
      registry.runs.push({
        id: 'run-1',
        subject: { repository: 'o/r', number: 1 },
        provider: 'agy',
        policy: { name: 'default', revision: 1 },
        lifecycle: 'running',
        orchestratorId: 'orch-1',
        brief: { path: briefPath, hash: 'h' },
      });
      registry.dispatches = [
        {
          id: 'dispatch-worker',
          generation: 1,
          provider: 'agy',
          stage: 'implementation',
          role: 'worker',
          runId: 'run-1',
          prerequisites: [],
          briefReference: { path: briefPath, hash: 'h' },
          lifecycle: 'running',
          attempts: [
            {
              id: 'attempt-worker',
              fleet: 'fleet-1',
              role: 'worker',
              runner: 'agy',
              brief: 'brief',
              status: 'running',
              created: '2026-11-01T01:00:00Z',
              directory: join(root, 'pool', 'worker'),
              checkout: join(root, 'pool', 'worker'),
              observation: {
                status: 'running',
                at: new Date(Date.now() - 60 * 60000).toISOString(),
                evidence: 'observation 60 min ago',
              },
            },
          ],
        },
      ];
    });
    mkdirSync(join(root, 'pool', 'worker', '.claude'));
    execFileSync('mkfifo', [join(root, 'pool', 'worker', '.claude', 'ralph-loop.local.md')]);
    let failed = false;
    let calls = 0;
    service = await createDashboard({
      dataDir: join(root, 'data'),
      configs: [config],
      token: 'test',
      host: 'local',
      runtimeIntervalMs: 60000,
      executeRuntime: async (program: string) => {
        calls++;
        if (failed) throw new Error('missing executable');
        return program === 'tmux'
          ? `%1\t${root}/pool/worker\t123\t0\tzsh\n%2\t/unrelated\t456\t0\tclaude`
          : 'zsh';
      },
    });
    const read = () =>
      service!.app.request('http://local/api/snapshot', {
        headers: { host: 'local', authorization: 'Bearer test' },
      });
    const first = await (await read()).json();
    const task = first.fleets[0].tasks.find((t: any) => t.id.includes(':managed:dispatch-worker'));
    expect(task).toBeDefined();
    expect(task.runtimeEvidence).toMatchObject({
      occupancy: 'unknown',
      tmux: { state: 'observed', panes: [{ id: '%1', command: 'zsh' }] },
      runner: { state: 'unknown' },
    });
    expect(task.interventions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: expect.stringContaining('Possibly stalled') }),
      ]),
    );
    const count = calls;
    await read();
    await read();
    expect(calls).toBe(count);
    failed = true;
    await service.refreshRuntime(true);
    const stale = await (await read()).json();
    const staleTask = stale.fleets[0].tasks.find((t: any) => t.id.includes(':managed:dispatch-worker'));
    expect(staleTask.runtimeEvidence).toMatchObject({
      stale: true,
      tmux: { panes: [{ id: '%1' }] },
      error: expect.any(String),
    });
    expect(staleTask.runtime).toBe('unknown');
  } finally {
    service?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
