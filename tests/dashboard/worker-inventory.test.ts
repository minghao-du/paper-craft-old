import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  readDashboardFleet,
  dashboardTaskSource,
} from '../../packages/core/src/workflow/fleet/dashboard.js';
import { readTaskLog } from '../../packages/dashboard/src/logs.js';
import { updateRunRegistry } from '@paper-craft/core/workflow/run-driver';
import { loadFleetConfig } from '@paper-craft/core/workflow/fleet-config';

test('Dashboard separates Managed execution records from configured-directory observations and ignores old lightweight records', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dashboard-managed-')));
  try {
    mkdirSync(join(root, 'pool', 'managed-slot'), { recursive: true });
    mkdirSync(join(root, 'pool', 'idle-slot'), { recursive: true });
    const configPath = join(root, '.epic-config.json');
    writeFileSync(
      configPath,
      JSON.stringify({ clone_root: 'pool', clone_names: ['managed-slot', 'idle-slot'] }),
    );
    const fleetConfig = loadFleetConfig(configPath);

    // Write brief and attempt.log for managed task
    const taskBriefPath = join(root, 'task-brief.md');
    writeFileSync(taskBriefPath, '# Task Brief\n');
    writeFileSync(
      join(root, 'pool', 'managed-slot', 'attempt.log'),
      'Managed worklog entry\nToken: sk-1234567890abcdef\n',
    );

    // Register Managed execution (run + dispatch + receipt) in RunRegistry
    updateRunRegistry(fleetConfig, (registry) => {
      registry.runs.push({
        id: 'run-101',
        subject: { repository: 'owner/repo', number: 101 },
        provider: 'codex',
        policy: { name: 'default', revision: 1 },
        lifecycle: 'running',
        orchestratorId: 'orch-att-1',
        brief: { path: join(root, 'brief.md'), hash: 'briefhash' },
        orchestrator: {
          id: 'orch-att-1',
          fleet: 'fleet-1',
          role: 'orchestrator',
          runner: 'codex',
          brief: 'brief',
          status: 'running',
          created: '2026-11-01T01:00:00Z',
          directory: root,
          checkout: root,
          conversation: 'orch-session',
          address: 'fleet:0.1',
          observation: {
            status: 'running',
            at: new Date().toISOString(),
            evidence: 'active prompt',
          },
        },
      });

      registry.dispatches = [
        {
          id: 'dispatch-m1',
          generation: 1,
          provider: 'codex',
          stage: 'unit-impl',
          role: 'worker',
          runId: 'run-101',
          prerequisites: [],
          briefReference: { path: taskBriefPath, hash: 'briefhash' },
          lifecycle: 'running',
          acceptedReceipt: 'receipt-m1',
          attempts: [
            {
              id: 'attempt-m1',
              fleet: 'fleet-1',
              role: 'worker',
              runner: 'codex',
              brief: 'brief',
              status: 'running',
              created: '2026-11-01T01:10:00Z',
              directory: join(root, 'pool', 'managed-slot'),
              checkout: join(root, 'pool', 'managed-slot'),
              conversation: 'worker-session',
              address: 'fleet:1.0',
              observation: {
                status: 'running',
                at: new Date().toISOString(),
                evidence: 'agent working',
              },
            },
          ],
        },
      ];

      registry.receipts = [
        {
          id: 'receipt-m1',
          dispatchId: 'dispatch-m1',
          attemptId: 'attempt-m1',
          runId: 'run-101',
          subject: 'owner/repo#101',
          role: 'worker',
          stage: 'unit-impl',
          outcome: 'success',
          summary: 'managed impl finished',
          completedAt: new Date().toISOString(),
          evidence: 'tested',
          receiptReference: { path: 'receipt.json', hash: 'rechash' },
        },
      ];
    });

    // Populate old lightweight records in .runtime/default/runs/.../dispatches/...
    const legacyDispatchDir = join(
      root,
      '.runtime/default/runs/legacy-run/dispatches/legacy-dispatch',
    );
    mkdirSync(legacyDispatchDir, { recursive: true });
    writeFileSync(
      join(legacyDispatchDir, 'dispatch.json'),
      JSON.stringify({
        dispatch_id: 'legacy-dispatch',
        run_id: 'legacy-run',
        issue_id: 99,
        role: 'worker',
        worktree: join(root, 'pool', 'legacy-worktree'),
      }),
    );
    writeFileSync(join(legacyDispatchDir, 'worker.log'), 'old legacy worker log');

    const fleet = await readDashboardFleet({ id: 'test', config: configPath });
    expect(fleet.error).toBeUndefined();

    // 1. Presence of old lightweight records must NOT produce extra Worker execution rows
    const legacyWorkerTasks = fleet.tasks.filter((t) => t.id.includes(':dispatch:'));
    expect(legacyWorkerTasks).toHaveLength(0);

    // 2. Managed execution attribution: Run and Dispatch projections remain intact
    const runTask = fleet.tasks.find((t) => t.runId === 'run-101');
    expect(runTask).toBeDefined();
    expect(runTask!.role).toBe('orchestrator');
    expect(runTask!.orchestratorId).toBe('orch-att-1');
    expect(runTask!.executionEvidence?.attempts[0].id).toBe('orch-att-1');

    const managedTask = fleet.tasks.find((t) => t.id === 'test:managed:dispatch-m1');
    expect(managedTask).toBeDefined();
    expect(managedTask!.dispatchId).toBe('dispatch-m1');
    expect(managedTask!.runId).toBe('run-101');
    expect(managedTask!.executionIdentity).toBe('attempt-m1');
    expect(managedTask!.executionEvidence?.acceptance).toBe('accepted');
    expect(managedTask!.executionEvidence?.receipts[0].accepted).toBe(true);

    // 3. Configured slot without managed task does NOT create a task (derived strictly from RunRegistry)
    const idleSlotTask = fleet.tasks.find((t) => t.id === 'test:idle-slot');
    expect(idleSlotTask).toBeUndefined();

    // 4. Log reading for managed tasks
    const execute = async (program: string, _args: string[]) => {
      if (program === 'tmux') {
        return `%1\t${join(root, 'pool', 'managed-slot')}\t1234\t0\tzsh`;
      }
      return '';
    };

    const managedLog = await readTaskLog(configPath, managedTask!, 'worklog', 0, execute);
    expect(managedLog).toMatchObject({
      state: 'read',
      kind: 'worklog',
    });
    expect(managedLog.text).toContain('Managed worklog entry');
    expect(managedLog.text).toContain('[credential omitted]');

    // 5. Terminal reading for managed task
    const terminalLog = await readTaskLog(configPath, managedTask!, 'terminal', 0, execute);
    expect(terminalLog).toMatchObject({
      kind: 'terminal',
      state: 'read',
    });

    // 6. Out-of-scope paths are explicitly unavailable
    const outOfScopeTask = {
      ...managedTask!,
      id: 'test:managed:out-of-scope',
      path: '/etc',
    };
    expect(await readTaskLog(configPath, outOfScopeTask, 'worklog', 0, execute)).toMatchObject({
      state: 'error',
    });

    // 7. Escaping symlink log is rejected
    const symlinkTask = {
      ...managedTask!,
      path: join(root, 'pool', 'managed-slot'),
    };
    rmSync(join(root, 'pool', 'managed-slot', 'attempt.log'));
    symlinkSync('/etc/passwd', join(root, 'pool', 'managed-slot', 'attempt.log'));
    expect(await readTaskLog(configPath, symlinkTask, 'worklog', 0, execute)).toMatchObject({
      state: 'error',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
