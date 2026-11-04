import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboard } from '../../packages/dashboard/src/server.js';
import { updateRunRegistry, inspectRuns } from '@paper-craft/core/workflow/run-driver';
import { loadFleetConfig } from '@paper-craft/core/workflow/fleet-config';

test('protected cached overview preserves registered workflow evidence after failed reads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-'));
  let dashboard;
  try {
    mkdirSync(join(root, 'pool'));
    mkdirSync(join(root, 'pool', 'worker'));
    const config = join(root, '.epic-config.json');
    writeFileSync(config, JSON.stringify({ clone_root: 'pool', clone_names: ['worker'] }));
    const configContent = JSON.stringify({ clone_root: 'pool', clone_names: ['worker'] });
    writeFileSync(config, configContent);
    const fleetConfig = loadFleetConfig(config);
    const briefPath = join(root, 'brief.md');
    writeFileSync(briefPath, '# Brief');
    updateRunRegistry(fleetConfig, (registry) => {
      registry.runs.push({
        id: 'run-overview',
        subject: { repository: 'owner/repo', number: 42, blockedBy: [10] },
        provider: 'codex',
        policy: { name: 'default', revision: 1 },
        lifecycle: 'running',
        phase: 'implementing',
        orchestratorId: 'orch-att',
        brief: { path: briefPath, hash: 'briefhash' },
        orchestrator: {
          id: 'orch-att',
          fleet: 'fleet-1',
          role: 'orchestrator',
          runner: 'codex',
          brief: 'brief',
          status: 'running',
          created: '2026-11-01T01:00:00Z',
          directory: root,
          checkout: root,
          observation: {
            status: 'running',
            at: new Date().toISOString(),
            evidence: 'active prompt',
          },
        },
      });
    });
    const cli = await promisify(execFile)(
      './pc',
      ['dashboard', 'status', '--config', config, '--data-dir', join(root, 'cli-data')],
      { timeout: 15000, maxBuffer: 1024 * 1024 },
    );
    expect(JSON.parse(cli.stdout).fleets[0].tasks[0].summary).toContain('owner/repo#42');
    dashboard = await createDashboard({
      dataDir: join(root, 'data'),
      configs: [config],
      token: 'test-secret',
      host: '127.0.0.1:7777',
      intervalMs: 60000,
    });
    const request = (path: string, headers: Record<string, string> = {}) =>
      dashboard!.app.request('http://127.0.0.1:7777' + path, {
        headers: { host: '127.0.0.1:7777', ...headers },
      });
    expect((await request('/api/snapshot')).status).toBe(401);
    expect(
      (
        await request('/api/snapshot', {
          authorization: 'Bearer test-secret',
          origin: 'https://evil.test',
        })
      ).status,
    ).toBe(403);
    const headers = { authorization: 'Bearer test-secret' };
    const snapshot = await (await request('/api/snapshot', headers)).json();
    expect(snapshot.fleets[0].tasks[0]).toMatchObject({
      phase: 'implementing',
      summary: expect.stringContaining('owner/repo#42'),
      runtime: 'unknown',
      executionIdentity: 'unknown',
    });
    expect(snapshot.fleets[0].tasks[0].interventions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'Dependency #10 remains open' }),
      ]),
    );
    expect(await (await request('/api/snapshot', headers)).json()).toEqual(snapshot);
    writeFileSync(config, '{broken');
    await dashboard.refresh(true);
    const failed = await (await request('/api/snapshot', headers)).json();
    expect(failed.fleets[0]).toMatchObject({ stale: true });
    expect(failed.fleets[0].error).toBeTruthy();
    expect(failed.fleets[0].tasks[0]).toMatchObject({
      summary: expect.stringContaining('owner/repo#42'),
    });
    expect(
      (
        await dashboard.app.request('http://127.0.0.1:7777/api/dispatch', {
          method: 'POST',
          headers: { host: '127.0.0.1:7777', ...headers },
        })
      ).status,
    ).toBe(405);
    writeFileSync(config, configContent);
    expect(readFileSync(config, 'utf8')).toBe(configContent);
  } finally {
    dashboard?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

test('dashboard HTTP snapshot exposes persistent execution, recovery and conflicting evidence while preserving read-only registry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-exec-'));
  let dashboard;
  try {
    mkdirSync(join(root, 'pool', 'worker'), { recursive: true });
    const configPath = join(root, '.epic-config.json');
    writeFileSync(configPath, JSON.stringify({ clone_root: 'pool', clone_names: ['worker'] }));
    const fleetConfig = loadFleetConfig(configPath);

    updateRunRegistry(fleetConfig, (registry) => {
      registry.runs.push({
        id: 'run-alpha',
        subject: { repository: 'owner/repo', number: 86 },
        provider: 'codex',
        policy: { name: 'default', revision: 1 },
        lifecycle: 'running',
        orchestratorId: 'orch-attempt-2',
        brief: { path: join(root, 'brief.md'), hash: 'briefhash' },
        priorOrchestrators: [
          {
            id: 'orch-attempt-1',
            fleet: 'fleet-1',
            role: 'orchestrator',
            runner: 'codex',
            brief: 'brief',
            status: 'running',
            created: '2026-11-01T00:00:00Z',
            directory: root,
            checkout: root,
            conversation: 'session-persistent-1',
            address: 'fleet:0.0',
            observation: {
              status: 'exited',
              at: '2026-11-01T00:05:00Z',
              evidence: 'process closed during reboot',
            },
          },
        ],
        orchestrator: {
          id: 'orch-attempt-2',
          predecessor: 'orch-attempt-1',
          fleet: 'fleet-1',
          role: 'orchestrator',
          runner: 'codex',
          brief: 'brief',
          status: 'running',
          created: '2026-11-01T01:00:00Z',
          directory: root,
          checkout: root,
          conversation: 'session-persistent-1',
          address: 'fleet:0.1',
          observation: {
            status: 'running',
            at: new Date().toISOString(),
            evidence: 'interactive prompt active',
          },
          startupFailures: [
            {
              error: 'port 4317 busy during recovery reconnect',
              resolvedAt: '2026-11-01T01:01:00Z',
            },
          ],
        },
      });

      registry.dispatches = [
        {
          id: 'dispatch-worker-1',
          generation: 1,
          provider: 'codex',
          stage: 'unit-implementation',
          role: 'worker',
          runId: 'run-alpha',
          prerequisites: [],
          briefReference: { path: join(root, 'task-brief.md'), hash: 'taskhash' },
          lifecycle: 'running',
          acceptedReceipt: 'receipt-worker-1',
          attempts: [
            {
              id: 'attempt-worker-1',
              fleet: 'fleet-1',
              role: 'worker',
              runner: 'codex',
              brief: 'brief',
              status: 'running',
              created: '2026-11-01T01:10:00Z',
              directory: join(root, 'pool', 'worker'),
              checkout: join(root, 'pool', 'worker'),
              conversation: 'worker-session-1',
              address: 'fleet:1.0',
              observation: {
                status: 'idle',
                at: new Date().toISOString(),
                evidence: 'awaiting next turn',
              },
            },
          ],
        },
      ];

      registry.receipts = [
        {
          id: 'receipt-worker-1',
          dispatchId: 'dispatch-worker-1',
          attemptId: 'attempt-worker-1',
          runId: 'run-alpha',
          subject: 'owner/repo#86',
          role: 'worker',
          stage: 'unit-implementation',
          outcome: 'success',
          summary: 'implementation finished',
          completedAt: new Date().toISOString(),
          evidence: 'git diff verified',
          receiptReference: { path: 'receipt.json', hash: 'rechash' },
        },
      ];
    });

    const registryBefore = JSON.stringify(inspectRuns(fleetConfig));

    dashboard = await createDashboard({
      dataDir: join(root, 'data'),
      configs: [configPath],
      token: 'secret-token',
      host: '127.0.0.1:8888',
      intervalMs: 60000,
      runtimeIntervalMs: 60000,
    });

    const headers = { authorization: 'Bearer secret-token' };
    const request = (path: string) =>
      dashboard!.app.request('http://127.0.0.1:8888' + path, {
        headers: { host: '127.0.0.1:8888', ...headers },
      });

    // Read-only semantics: registry state was not altered by createDashboard or snapshot reads
    expect(JSON.stringify(inspectRuns(fleetConfig))).toBe(registryBefore);
    const snapshotRes = await request('/api/snapshot');
    expect(snapshotRes.status).toBe(200);
    expect(JSON.stringify(inspectRuns(fleetConfig))).toBe(registryBefore);
    const snapshot = await snapshotRes.json();

    const runTask = snapshot.fleets[0].tasks.find(
      (t: { runId?: string }) => t.runId === 'run-alpha',
    );
    expect(runTask).toBeDefined();
    expect(runTask.orchestratorId).toBe('orch-attempt-2');
    expect(runTask.runtime).toBe('unknown');
    expect(runTask.executionIdentity).toBe('unknown');
    expect(runTask.executionEvidence).toMatchObject({
      acceptance: 'unknown',
      attempts: [
        {
          id: 'orch-attempt-1',
          conversation: 'session-persistent-1',
          address: 'fleet:0.0',
          execution: 'exited',
          stale: true,
        },
        {
          id: 'orch-attempt-2',
          predecessor: 'orch-attempt-1',
          conversation: 'session-persistent-1',
          address: 'fleet:0.1',
          execution: 'running',
          stale: false,
          startupFailures: [
            {
              error: 'port 4317 busy during recovery reconnect',
              resolvedAt: '2026-11-01T01:01:00Z',
            },
          ],
        },
      ],
      uncertainty: expect.stringContaining('Recorded observations are not current liveness'),
    });

    const managedTask = snapshot.fleets[0].tasks.find((t: { id: string }) =>
      t.id.includes(':managed:dispatch-worker-1'),
    );
    expect(managedTask).toBeDefined();
    expect(managedTask.executionEvidence).toMatchObject({
      acceptance: 'accepted',
      receipts: [
        {
          id: 'receipt-worker-1',
          attemptId: 'attempt-worker-1',
          outcome: 'success',
          accepted: true,
        },
      ],
      attempts: [
        {
          id: 'attempt-worker-1',
          conversation: 'worker-session-1',
          address: 'fleet:1.0',
          execution: 'idle',
          stale: false,
        },
      ],
    });

    // Induce conflicting receipt acceptance evidence
    updateRunRegistry(fleetConfig, (registry) => {
      registry.dispatches![0].acceptedReceipt = 'nonexistent-receipt';
    });
    const beforeRefresh = JSON.stringify(inspectRuns(fleetConfig));
    await dashboard.refresh(true);
    expect(JSON.stringify(inspectRuns(fleetConfig))).toBe(beforeRefresh);
    const refreshRes = await request('/api/snapshot');
    const conflictingSnapshot = await refreshRes.json();
    const conflictingTask = conflictingSnapshot.fleets[0].tasks.find((t: { id: string }) =>
      t.id.includes(':managed:dispatch-worker-1'),
    );
    expect(conflictingTask.executionEvidence.acceptance).toBe('conflicting');
  } finally {
    dashboard?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
