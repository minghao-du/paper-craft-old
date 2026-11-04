import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboard } from '../../packages/dashboard/src/server.js';
import { updateRunRegistry } from '@paper-craft/core/workflow/run-driver';
import { loadFleetConfig } from '@paper-craft/core/workflow/fleet-config';

test('multi-Fleet evidence retains invalid registrations and explains waiting and intervention', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-multi-'));
  let dashboard;
  try {
    const configs = ['alpha', 'beta'].map((name) => {
      const dir = join(root, name);
      mkdirSync(join(dir, 'pool'), { recursive: true });
      const config = join(dir, '.epic-config.json');
      writeFileSync(config, JSON.stringify({ clone_root: 'pool' }));
      return config;
    });
    const alphaConfig = loadFleetConfig(configs[0]);
    const alphaBrief = join(root, 'alpha', 'brief.md');
    writeFileSync(alphaBrief, '# Brief Alpha');
    updateRunRegistry(alphaConfig, (registry) => {
      registry.runs.push({
        id: 'run-alpha',
        subject: { repository: 'example/repo', number: 42, title: 'Experiment' },
        provider: 'codex',
        policy: { name: 'default', revision: 1 },
        lifecycle: 'running',
        phase: 'awaiting-results' as any,
        orchestratorId: 'orch-alpha',
        brief: { path: alphaBrief, hash: 'h' },
        awaiting: { next_check_at: '2099-01-01T00:00:00Z' },
      } as any);
    });

    const betaConfig = loadFleetConfig(configs[1]);
    const betaBrief = join(root, 'beta', 'brief.md');
    writeFileSync(betaBrief, '# Brief Beta');
    updateRunRegistry(betaConfig, (registry) => {
      registry.runs.push({
        id: 'run-beta',
        subject: { repository: 'example/repo', number: 42, title: 'Choose parameter' },
        provider: 'codex',
        policy: { name: 'default', revision: 1 },
        lifecycle: 'running',
        phase: 'needs-human' as any,
        orchestratorId: 'orch-beta',
        brief: { path: betaBrief, hash: 'h' },
        blockers: ['Choose cutoff'],
        pr: 'https://github.com/example/repo/pull/3',
      } as any);
    });
    const options = {
      dataDir: join(root, 'data'),
      configs: [...configs, join(root, 'missing.json')],
      project: 'Research A',
      token: 'test',
      host: '127.0.0.1:7777',
    };
    dashboard = await createDashboard(options);
    const read = async (path: string) =>
      (
        await dashboard!.app.request('http://127.0.0.1:7777' + path, {
          headers: { host: options.host, authorization: 'Bearer test' },
        })
      ).json();
    const all = await read('/api/snapshot');
    expect(all.fleets).toHaveLength(3);
    expect(all.fleets[0].project).toBe('Research A');
    expect(all.fleets[0].tasks[0]).toMatchObject({ waiting: 'planned', interventions: [] });
    expect(all.fleets[1].tasks[0].interventions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'Choose cutoff',
          source: alphaBrief ? betaBrief : '',
        }),
      ]),
    );
    expect(all.fleets[2].error).toBeTruthy();
    expect(all.fleets[0].tasks[0].id).not.toBe(all.fleets[1].tasks[0].id);
    expect((await read('/api/snapshot?q=Choose')).fleets.flatMap((f: any) => f.tasks)).toHaveLength(
      1,
    );
    expect((await read('/api/snapshot?fleet=' + all.fleets[0].id)).fleets).toHaveLength(1);
    updateRunRegistry(alphaConfig, (reg) => {
      (reg.runs[0] as any).awaiting = { next_check_at: '2000-01-01T00:00:00Z' };
    });
    await dashboard.refresh(true);
    const overdue = (await read('/api/snapshot')).fleets[0].tasks[0];
    expect(overdue.waiting).toBe('overdue');
    expect(overdue.interventions).toContainEqual({
      reason: 'Saved next check is overdue; investigate',
      source: alphaBrief,
    });
    updateRunRegistry(alphaConfig, (reg) => {
      reg.runs[0].phase = 'implementing' as any;
      (reg.runs[0] as any).awaiting = undefined;
    });
    await dashboard.refresh(true);
    expect((await read('/api/snapshot')).fleets[0].tasks[0].interventions).toEqual([]);
    dashboard.stop();
    dashboard = await createDashboard({ ...options, configs: [] });
    expect((await read('/api/snapshot')).fleets).toHaveLength(3);
  } finally {
    dashboard?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
