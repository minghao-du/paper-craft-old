import { test, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startRun,
  recoverRun,
  inspectRuns,
  updateRunRegistry,
  dispatchStage,
} from '../../packages/core/src/workflow/run/run-driver.js';
import { home } from '../../packages/core/src/workflow/run/run-driver.js';
import { recoverAllRuns } from '../../packages/core/src/workflow/run/recovery.js';
import { readDashboardFleet } from '../../packages/core/src/workflow/fleet/dashboard.js';
import { AgyRunner } from '../../packages/core/src/workflow/runtime/agy-runner.js';
import type { ManagedAttempt } from '../../packages/core/src/workflow/runtime/runtime.js';
import { initializeRole } from './initialize-role.js';

function createFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-recovery-obs-')));
  mkdirSync(join(root, 'pool'));
  const config = {
    file: join(root, '.epic-config.json'),
    project: root,
    root: join(root, 'pool'),
    slots: [],
    worktrees: true,
    base: 'main',
  };
  writeFileSync(config.file, JSON.stringify({ clone_root: 'pool', clone_names: [] }));
  return {
    root,
    config,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('restart recovery recovers existing execution without relaunch, preserving fixed provider and encapsulating providerState', async () => {
  const f = createFixture();
  let startCount = 0;
  let recoverReceiptCount = 0;

  const runner = {
    name: 'agy',
    interactive: true,
    automaticStartup: true,
    async preflight() {},
    async stopped() {
      return false;
    },
    async observe(a: ManagedAttempt) {
      return {
        status: 'running' as const,
        at: new Date().toISOString(),
        evidence: 'tmux pane alive and agy idle',
      };
    },
    async start(a: ManagedAttempt) {
      startCount++;
      a.conversation = 'conv-initial';
      a.address = 'tmux:%1';
      a.providerState = {
        session: `pc-run-${a.run}`,
        paneId: '%1',
        windowId: '@1',
        address: 'tmux:%1',
        conversation: 'conv-initial',
        run: a.run,
      };
      initializeRole(a);
      return {
        conversation: 'conv-initial',
        address: 'tmux:%1',
        evidence: 'native agy started',
      };
    },
    async recoverReceipt(a: ManagedAttempt) {
      recoverReceiptCount++;
      // Simulate verifying existing provider state from attempt
      expect(a.providerState).toBeDefined();
      expect(a.providerState?.session).toBe(`pc-run-${a.run}`);
      expect(a.providerState?.paneId).toBe('%1');
      initializeRole(a);
      return {
        conversation: a.conversation ?? 'conv-initial',
        address: a.address ?? 'tmux:%1',
        evidence: 'native agy recovered receipt',
      };
    },
  };

  try {
    const subject = {
      repository: 'owner/repo',
      number: 101,
      kind: 'issue' as const,
      title: 'Run recovery',
      body: 'Testing recovery',
    };

    const run = await startRun(f.config, runner, subject, 'agy');
    expect(run.lifecycle).toBe('running');
    expect(startCount).toBe(1);

    // Verify initial provider state was encapsulated
    const initialAttempt = inspectRuns(f.config).runs[0].orchestrator!;
    expect(initialAttempt.providerState).toEqual(
      expect.objectContaining({
        session: `pc-run-${run.id}`,
        paneId: '%1',
        windowId: '@1',
        address: 'tmux:%1',
      }),
    );

    // Simulate host restart: clear runner state, set attempt status to unknown to simulate reboot gap
    updateRunRegistry(f.config, (reg) => {
      reg.runs[0].lifecycle = 'blocked';
      reg.runs[0].orchestrator!.status = 'unknown';
    });

    // Recover existing execution without relaunching
    const receiptCountBefore = recoverReceiptCount;
    const result = await recoverRun(f.config, runner, run.id);
    expect(result.blockers).toEqual([]);

    // Verify start was NOT called again (relaunch prevented)
    expect(startCount).toBe(1);
    expect(recoverReceiptCount).toBeGreaterThanOrEqual(1);

    const recoveredRun = inspectRuns(f.config).runs[0];
    expect(recoveredRun.lifecycle).toBe('running');
    expect(recoveredRun.provider).toBe('agy');
    expect(recoveredRun.orchestrator?.status).toBe('running');
    expect(recoveredRun.orchestrator?.providerState).toEqual(
      expect.objectContaining({
        session: `pc-run-${run.id}`,
        paneId: '%1',
        windowId: '@1',
      }),
    );
  } finally {
    f.cleanup();
  }
});

test('recovery refuses mismatched Run or attempt ownership', async () => {
  const f = createFixture();
  const runner = {
    name: 'agy',
    interactive: true,
    automaticStartup: true,
    async preflight() {},
    async stopped() {
      return false;
    },
    async start(a: ManagedAttempt) {
      a.conversation = 'conv-1';
      a.address = 'tmux:%1';
      a.providerState = {
        session: `pc-run-${a.run}`,
        paneId: '%1',
        windowId: '@1',
        address: 'tmux:%1',
        run: a.run,
      };
      initializeRole(a);
      return { conversation: 'conv-1', address: 'tmux:%1', evidence: 'started' };
    },
    async recoverReceipt(a: ManagedAttempt) {
      initializeRole(a);
      return { conversation: 'conv-1', address: 'tmux:%1', evidence: 'recovered' };
    },
  };

  try {
    const subject = {
      repository: 'owner/repo',
      number: 102,
      kind: 'issue' as const,
      title: 'Ownership check',
      body: 'Testing ownership',
    };

    const run = await startRun(f.config, runner, subject, 'agy');

    // 1. Mismatched runner passed to recoverRun
    const wrongRunner = { ...runner, name: 'codex' };
    await expect(recoverRun(f.config, wrongRunner, run.id)).rejects.toThrow(
      /Run provider mismatch: expected provider agy, but received codex/,
    );

    // 2. Mismatched orchestrator Run ownership
    updateRunRegistry(f.config, (reg) => {
      reg.runs[0].orchestrator!.run = 'mismatched-run-id';
    });
    await expect(recoverRun(f.config, runner, run.id)).rejects.toThrow(
      /Run orchestrator ownership mismatch/,
    );

    // Fix orchestrator run ownership
    updateRunRegistry(f.config, (reg) => {
      reg.runs[0].orchestrator!.run = run.id;
    });

    // 3. Mismatched orchestrator provider
    updateRunRegistry(f.config, (reg) => {
      reg.runs[0].orchestrator!.runner = 'codex';
    });
    await expect(recoverRun(f.config, runner, run.id)).rejects.toThrow(
      /Run provider mismatch: expected provider agy, but received codex/,
    );

    // Reset orchestrator runner
    updateRunRegistry(f.config, (reg) => {
      reg.runs[0].orchestrator!.runner = 'agy';
    });

    // 4. Mismatched dispatch child attempt Run ownership
    const dispatch = await dispatchStage(f.config, runner, {
      runId: run.id,
      authority: run.orchestratorId,
      subject: 'owner/repo#102',
      role: 'worker',
      stage: 'implementation',
      inputRevision: '1',
      brief: 'Implement task',
      prerequisites: [],
    });

    updateRunRegistry(f.config, (reg) => {
      const d = reg.dispatches?.find((x) => x.id === dispatch.id);
      if (d) d.attempts[0].run = 'foreign-run-id';
    });
    await expect(recoverRun(f.config, runner, run.id)).rejects.toThrow(
      /Dispatch attempt Run ownership mismatch/,
    );

    // 5. Mismatched dispatch child attempt provider
    updateRunRegistry(f.config, (reg) => {
      const d = reg.dispatches?.find((x) => x.id === dispatch.id);
      if (d) {
        d.attempts[0].run = run.id;
        d.attempts[0].runner = 'codex';
      }
    });
    await expect(recoverRun(f.config, runner, run.id)).rejects.toThrow(
      /Attempt provider mismatch/,
    );
  } finally {
    f.cleanup();
  }
});

test('missing, corrupt or unconfirmed recovery evidence produces explicit blockers and retains occupancy', async () => {
  const f = createFixture();

  let receiptResult: { conversation: string; address: string; evidence: string } | undefined;
  let receiptError: Error | undefined;

  const runner = {
    name: 'agy',
    interactive: true,
    automaticStartup: true,
    async preflight() {},
    async stopped() {
      return false;
    },
    async observe() {
      return { status: 'running' as const, at: new Date().toISOString(), evidence: 'live' };
    },
    async start(a: ManagedAttempt) {
      a.conversation = 'conv-evidence';
      a.address = 'tmux:%1';
      a.providerState = {
        session: `pc-run-${a.run}`,
        paneId: '%1',
        windowId: '@1',
        address: 'tmux:%1',
        run: a.run,
      };
      initializeRole(a);
      return { conversation: 'conv-evidence', address: 'tmux:%1', evidence: 'started' };
    },
    async recoverReceipt(a: ManagedAttempt) {
      if (receiptError) throw receiptError;
      if (receiptResult) initializeRole(a);
      return receiptResult;
    },
  };

  try {
    const subject = {
      repository: 'owner/repo',
      number: 103,
      kind: 'issue' as const,
      title: 'Evidence tests',
      body: 'Testing corrupted evidence handling',
    };

    const run = await startRun(f.config, runner, subject, 'agy');

    // Case 1: Unconfirmed recovery evidence (receipt undefined)
    receiptResult = undefined;
    updateRunRegistry(f.config, (reg) => {
      reg.runs[0].lifecycle = 'blocked';
      reg.runs[0].orchestrator!.status = 'unknown';
    });

    const unconfirmed = await recoverRun(f.config, runner, run.id);
    expect(unconfirmed.blockers).toContain(
      'Orchestrator startup pending; unknown occupancy remains reserved',
    );
    expect(inspectRuns(f.config).runs[0].lifecycle).toBe('blocked');
    expect(inspectRuns(f.config).runs[0].orchestrator?.id).toBe(run.orchestratorId);

    // Case 2: Corrupt provider recovery evidence throws explicit error
    receiptError = new Error('Corrupt terminal recovery evidence in /path: Unexpected token');
    const corrupt = await recoverRun(f.config, runner, run.id);
    expect(corrupt.blockers.some((b) => b.includes('Corrupt terminal recovery evidence'))).toBe(true);
    expect(inspectRuns(f.config).runs[0].lifecycle).toBe('blocked');
    expect(inspectRuns(f.config).runs[0].orchestrator?.id).toBe(run.orchestratorId);

    // Case 3: Corrupt orchestrator-<runId>.json on disk
    const orchFile = join(home(f.config), `orchestrator-${run.id}.json`);
    writeFileSync(orchFile, '{ invalid json content');
    // Clear orchestrator on run record to force reading from disk
    updateRunRegistry(f.config, (reg) => {
      delete reg.runs[0].orchestrator;
    });

    const corruptDisk = await recoverRun(f.config, runner, run.id);
    expect(corruptDisk.blockers.some((b) => b.includes('Orchestrator recovery evidence corrupt'))).toBe(true);
    expect(inspectRuns(f.config).runs[0].lifecycle).toBe('blocked');
  } finally {
    f.cleanup();
  }
});

test('batch recovery isolates individual Run failures and preserves progress across runs', async () => {
  const f = createFixture();

  const runner = {
    name: 'agy',
    interactive: true,
    automaticStartup: true,
    async preflight() {},
    async stopped() {
      return false;
    },
    async observe() {
      return { status: 'running' as const, at: new Date().toISOString(), evidence: 'running' };
    },
    async start(a: ManagedAttempt) {
      a.conversation = `conv-${a.id}`;
      a.address = `tmux:%${a.id}`;
      a.providerState = {
        session: `pc-run-${a.run}`,
        paneId: `%${a.id}`,
        address: a.address,
        run: a.run,
      };
      initializeRole(a);
      return { conversation: a.conversation, address: a.address, evidence: 'started' };
    },
    async recoverReceipt(a: ManagedAttempt) {
      initializeRole(a);
      return { conversation: a.conversation ?? 'recovered', address: a.address ?? 'tmux:%1', evidence: 'recovered' };
    },
  };

  try {
    const run1 = await startRun(
      f.config,
      runner,
      { repository: 'owner/repo', number: 201, kind: 'issue', title: 'Run 1', body: 'body' },
      'agy',
    );
    const run2 = await startRun(
      f.config,
      runner,
      { repository: 'owner/repo', number: 202, kind: 'issue', title: 'Run 2', body: 'body' },
      'agy',
    );
    const run3 = await startRun(
      f.config,
      runner,
      { repository: 'owner/repo', number: 203, kind: 'issue', title: 'Run 3', body: 'body' },
      'agy',
    );

    // Make run1 fail with mismatched ownership
    updateRunRegistry(f.config, (reg) => {
      reg.runs.find((r) => r.id === run1.id)!.orchestrator!.run = 'mismatched-ownership';
      reg.runs.find((r) => r.id === run1.id)!.lifecycle = 'blocked';
    });

    // Run 2 is healthy, simulated re-entry
    updateRunRegistry(f.config, (reg) => {
      reg.runs.find((r) => r.id === run2.id)!.lifecycle = 'blocked';
    });

    // Run 3 is healthy, simulated re-entry
    updateRunRegistry(f.config, (reg) => {
      reg.runs.find((r) => r.id === run3.id)!.lifecycle = 'blocked';
    });

    // Run batch recovery
    const batch = await recoverAllRuns(f.config, () => runner);

    expect(batch.outcomes).toHaveLength(3);
    const outcome1 = batch.outcomes.find((o) => o.run === run1.id);
    const outcome2 = batch.outcomes.find((o) => o.run === run2.id);
    const outcome3 = batch.outcomes.find((o) => o.run === run3.id);

    // Run 1 failure is isolated
    expect(outcome1?.error).toContain('Run orchestrator ownership mismatch');

    // Run 2 recovered successfully without being stopped by Run 1's failure
    expect(outcome2?.error).toBeUndefined();
    expect(outcome2?.blockers).toEqual([]);

    // Run 3 recovered successfully without being stopped by Run 1's failure
    expect(outcome3?.error).toBeUndefined();
    expect(outcome3?.blockers).toEqual([]);

    // Overall status is unknown because run1 had an error
    expect(batch.status).toBe('unknown');

    // In registry, Run 2 and Run 3 are running
    const reg = inspectRuns(f.config);
    expect(reg.runs.find((r) => r.id === run2.id)?.lifecycle).toBe('running');
    expect(reg.runs.find((r) => r.id === run3.id)?.lifecycle).toBe('running');
    // Run 1 remains blocked, occupancy retained
    expect(reg.runs.find((r) => r.id === run1.id)?.lifecycle).toBe('blocked');
  } finally {
    f.cleanup();
  }
});

test('Dashboard observation reads common evidence without side effects or execution dependencies', async () => {
  const f = createFixture();

  const runner = {
    name: 'agy',
    interactive: true,
    automaticStartup: true,
    async preflight() {},
    async stopped() {
      return false;
    },
    async start(a: ManagedAttempt) {
      a.conversation = 'conv-dash';
      a.address = 'tmux:%10';
      a.providerState = {
        session: `pc-run-${a.run}`,
        paneId: '%10',
        windowId: '@5',
        secretToken: 'do-not-leak',
      };
      initializeRole(a);
      return { conversation: 'conv-dash', address: 'tmux:%10', evidence: 'started' };
    },
  };

  try {
    const run = await startRun(
      f.config,
      runner,
      { repository: 'owner/repo', number: 301, kind: 'issue', title: 'Dash Run', body: 'body' },
      'agy',
    );

    const fleet = await readDashboardFleet({ id: 'fleet-test', config: f.config.file });
    expect(fleet.error).toBeUndefined();
    expect(fleet.runs).toHaveLength(1);
    expect(fleet.runs?.[0].id).toBe(run.id);

    const orchTask = fleet.tasks.find((t) => t.id === `fleet-test:run:${run.id}`);
    expect(orchTask).toBeDefined();
    expect(orchTask?.runId).toBe(run.id);
    expect(orchTask?.orchestratorId).toBe(run.orchestratorId);

    // Common evidence is read
    const execution = orchTask?.executionEvidence;
    expect(execution?.attempts).toHaveLength(1);
    const attemptView = execution?.attempts[0];
    expect(attemptView?.id).toBe(run.orchestratorId);
    expect(attemptView?.role).toBe('orchestrator');
    expect(attemptView?.runner).toBe('agy');
    expect(attemptView?.conversation).toBe('conv-dash');
    expect(attemptView?.address).toBe('tmux:%10');

    // Provider-specific internal fields (providerState, paneId, windowId) are NOT exposed in DashboardExecution.attempts
    expect((attemptView as Record<string, unknown>).providerState).toBeUndefined();
    expect((attemptView as Record<string, unknown>).paneId).toBeUndefined();
    expect((attemptView as Record<string, unknown>).windowId).toBeUndefined();
    expect((attemptView as Record<string, unknown>).secretToken).toBeUndefined();
  } finally {
    f.cleanup();
  }
});
