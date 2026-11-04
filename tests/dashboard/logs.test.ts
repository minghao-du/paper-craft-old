import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboard } from '../../packages/dashboard/src/server.js';
import { updateRunRegistry } from '@paper-craft/core/workflow/run-driver';
import { loadFleetConfig } from '@paper-craft/core/workflow/fleet-config';

test('authenticated logs are bounded, segmented and restricted to verified registered sources', async () => {
  const root = mkdtempSync(join(tmpdir(), 'logs-'));
  let service;
  let moved = false;
  let captures = 0;
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
            },
          ],
        },
      ];
    });
    const log = join(root, 'pool', 'worker', 'attempt.log');
    const original = 'Progress\n'.repeat(10000) + 'Authorization: Bearer private-secret\n';
    writeFileSync(log, original);
    service = await createDashboard({
      dataDir: join(root, 'data'),
      configs: [config],
      token: 'test',
      host: 'local',
      executeRuntime: async (program, args) => {
        if (args[0] === 'capture-pane') {
          captures++;
          moved = true;
          return 'private result';
        }
        if (program === 'tmux')
          return `%1\t${moved ? '/elsewhere' : join(root, 'pool', 'worker')}\t123\t0\tzsh`;
        return 'zsh';
      },
    });
    const get = (url: string, auth = true) =>
      service!.app.request('http://local' + url, {
        headers: { host: 'local', ...(auth ? { authorization: 'Bearer test' } : {}) },
      });
    const snapshot = await (await get('/api/snapshot')).json();
    const task = snapshot.fleets[0].tasks.find((t: any) => t.id.includes(':managed:dispatch-worker'));
    expect(task).toBeDefined();
    const id = encodeURIComponent(task.id);
    const url = `/api/tasks/${id}/logs`;
    expect((await get(url, false)).status).toBe(401);
    const first = await (await get(url)).json();
    expect(first).toMatchObject({ kind: 'worklog', state: 'read', offset: 0, nextOffset: 16380 });
    expect(first.text.length).toBeLessThanOrEqual(16384);
    const last = await (await get(url + '?offset=79990')).json();
    expect(last.text).not.toContain('private-secret');
    expect((await get(url + '?path=/etc/passwd')).status).toBe(400);
    expect((await get(url + '?source=runner')).status).toBe(200);
    expect(await (await get(url + '?source=runner')).json()).toMatchObject({ state: 'unknown' });
    const crossing = 'prefix\n' + 'x'.repeat(16370) + '\ncrossing-line-must-survive\nlast\n';
    writeFileSync(log, crossing);
    let combined = '',
      cursor = 0;
    do {
      const page = await (await get(url + '?offset=' + cursor)).json();
      combined += page.text;
      cursor = page.nextOffset;
    } while (cursor !== null);
    expect(combined).toBe(crossing);
    writeFileSync(log, '<prompt>\n' + 'PRIVATE-CONTINUATION\n'.repeat(2000));
    const privatePage = await (await get(url + '?offset=16384')).json();
    expect(privatePage.text).not.toContain('PRIVATE-CONTINUATION');
    const splitMarker = await (await get(url + '?offset=2')).json();
    expect(splitMarker.text).not.toContain('PRIVATE-CONTINUATION');
    writeFileSync(log, 'x'.repeat(20000));
    const oversized = await (await get(url)).json();
    expect(oversized).toMatchObject({ text: '[oversized log line omitted]', nextOffset: 16384 });
    const refused = await (await get(url + '?offset=1048576')).json();
    expect(refused).toMatchObject({ state: 'error' });
    expect(refused.error).toContain('1 MiB');
    rmSync(log);
    symlinkSync('/etc/passwd', log);
    expect(await (await get(url)).json()).toMatchObject({ state: 'error' });
    expect((await get('/api/tasks/unknown/logs')).status).toBe(404);
    const terminal = await (await get(url + '?source=terminal')).json();
    expect(terminal).toMatchObject({
      state: 'unknown',
      error: 'Terminal identity changed during read',
    });
    expect(terminal.text).toBeUndefined();
    expect(captures).toBe(1);
  } finally {
    service?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
