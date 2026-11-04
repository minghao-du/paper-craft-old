import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboard } from '../../packages/dashboard/src/server.js';
import { updateRunRegistry, inspectRuns } from '@paper-craft/core/workflow/run-driver';
import { loadFleetConfig } from '@paper-craft/core/workflow/fleet-config';

test('history retains meaningful observations, marks restart gaps and prunes only owned records', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-history-'));
  let dashboard;
  let now = Date.parse('2026-01-01T00:00:00Z');
  try {
    mkdirSync(join(root, 'pool'));
    const config = join(root, '.epic-config.json');
    writeFileSync(config, JSON.stringify({ clone_root: 'pool', clone_names: [] }));
    const fleetConfig = loadFleetConfig(config);
    updateRunRegistry(fleetConfig, (registry) => {
      registry.runs.push({
        id: 'run-history',
        subject: { repository: 'o/r', number: 1 },
        provider: 'codex',
        policy: { name: 'default', revision: 1 },
        lifecycle: 'running',
        phase: 'implementing',
        orchestratorId: 'orch-1',
        brief: { path: join(root, 'brief.md'), hash: 'h' },
      });
    });
    const options = {
      dataDir: join(root, 'data'),
      configs: [config],
      token: 'secret',
      historyNow: () => now,
    };
    dashboard = await createDashboard(options);
    const read = () =>
      dashboard!.app
        .request('http://127.0.0.1:4317/api/history', {
          headers: { host: '127.0.0.1:4317', authorization: 'Bearer secret' },
        })
        .then((r) => r.json());
    expect(
      (
        await dashboard.app.request('http://127.0.0.1:4317/api/history', {
          headers: { host: '127.0.0.1:4317' },
        })
      ).status,
    ).toBe(401);
    const first = await read();
    expect(first.events.some((e: { source: string }) => e.source === 'local')).toBe(true);
    await dashboard.refresh(true);
    expect((await read()).events).toEqual(first.events);
    now += 1000;
    updateRunRegistry(fleetConfig, (registry) => {
      registry.runs[0].phase = 'testing';
    });
    await dashboard.refresh(true);
    const changed = await read();
    expect(changed.events.length).toBeGreaterThan(first.events.length);
    expect(JSON.stringify(changed)).not.toContain('private prompt secret');
    expect(
      changed.events.every((e: { executionIdentity: string }) => e.executionIdentity === 'unknown'),
    ).toBe(true);
    dashboard.stop();
    now += 60000;
    dashboard = await createDashboard(options);
    expect((await read()).events.some((e: { kind: string }) => e.kind === 'monitoring-gap')).toBe(
      true,
    );
    dashboard.stop();
    now += 31 * 86400000;
    dashboard = await createDashboard(options);
    expect(
      (await read()).events.every(
        (e: { observedAt: string }) => Date.parse(e.observedAt) >= now - 30 * 86400000,
      ),
    ).toBe(true);
    expect(inspectRuns(fleetConfig).runs[0].phase).toBe('testing');
  } finally {
    dashboard?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
