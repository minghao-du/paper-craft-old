import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboard } from '../../packages/dashboard/src/server.js';

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
    const status = join(root, 'alpha', '.epic-status.json');
    writeFileSync(
      status,
      JSON.stringify({
        issue: 42,
        phase: 'awaiting-results',
        summary: 'Experiment',
        awaiting: { next_check_at: '2099-01-01T00:00:00Z' },
      }),
    );
    utimesSync(status, new Date('2000-01-01'), new Date('2000-01-01'));
    writeFileSync(
      join(root, 'beta', '.epic-status.json'),
      JSON.stringify({
        issue: 42,
        phase: 'needs-human',
        summary: 'Choose parameter',
        blockers: ['Choose cutoff'],
        pr: 'https://github.com/example/repo/pull/3',
      }),
    );
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
          source: join(realpathSync(root), 'beta', '.epic-status.json'),
        }),
      ]),
    );
    expect(all.fleets[2].error).toBeTruthy();
    expect(all.fleets[0].tasks[0].id).not.toBe(all.fleets[1].tasks[0].id);
    expect((await read('/api/snapshot?q=Choose')).fleets.flatMap((f: any) => f.tasks)).toHaveLength(
      1,
    );
    expect((await read('/api/snapshot?fleet=' + all.fleets[0].id)).fleets).toHaveLength(1);
    writeFileSync(
      status,
      JSON.stringify({
        phase: 'awaiting-results',
        awaiting: { next_check_at: '2000-01-01T00:00:00Z' },
      }),
    );
    await dashboard.refresh(true);
    const overdue = (await read('/api/snapshot')).fleets[0].tasks[0];
    expect(overdue.waiting).toBe('overdue');
    expect(overdue.interventions).toContainEqual({
      reason: 'Saved next check is overdue; investigate',
      source: join(realpathSync(root), 'alpha', '.epic-status.json'),
    });
    writeFileSync(
      status,
      JSON.stringify({
        phase: 'implementing',
        pr: 'https://github.com/example/repo/pull/9',
        updated_at: '2000-01-01',
      }),
    );
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
