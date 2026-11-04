import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  startRun,
  recoverRun,
  inspectRuns,
  dispatchStage,
  retryStage,
  collectBusinessTurn,
  sendStageMessage,
  updateRunRegistry,
} from '../../packages/core/src/workflow/run/run-driver.js';
import {
  requestManagedStartup,
  reconcileStartup,
  startupOutcome,
  startupPending,
} from '../../packages/core/src/workflow/run/startup.js';
import type { ManagedAttempt, RunnerAdapter } from '../../packages/core/src/workflow/runtime/runtime.js';
import { initializeRole } from './initialize-role.js';

function createFixture() {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-unified-startup-')));
  mkdirSync(join(project, 'pool'));
  const config = {
    file: join(project, '.epic-config.json'),
    project,
    root: join(project, 'pool'),
    slots: [],
    worktrees: true,
    base: 'main',
  };
  writeFileSync(config.file, JSON.stringify({ clone_root: 'pool', local_worktrees: true }));

  let launches = 0;
  let readyReceipt = true;
  let readyInit = true;
  let stopped = false;
  const sentActivations: string[] = [];
  const stoppedAttempts = new Set<string>();

  const runner: RunnerAdapter & {
    collect(a: ManagedAttempt): Promise<string>;
    stopped(a: ManagedAttempt): Promise<boolean>;
  } = {
    name: 'agy',
    interactive: true,
    automaticStartup: true,
    cancellation: true,
    async preflight() {},
    async stopped(a: ManagedAttempt) {
      return stoppedAttempts.has(a.id) || (stoppedAttempts.size === 0 && stopped);
    },
    async start(a: ManagedAttempt) {
      launches++;
      a.terminalSession = `pc-run-${a.run}`;
      a.address = `tmux:%${launches}`;
      if (!readyReceipt) {
        throw new Error('Native startup unacknowledged: receipt pending');
      }
      if (readyInit) {
        initializeRole(a);
      }
      return {
        conversation: `native-${launches}`,
        address: a.address,
        evidence: 'native startup evidence',
      };
    },
    async recoverReceipt(a: ManagedAttempt) {
      if (!readyReceipt) return undefined;
      return {
        conversation: a.conversation || `native-${launches}`,
        address: a.address || `tmux:%${launches}`,
        evidence: 'recovered native receipt',
      };
    },
    async send(_a: ManagedAttempt, message: { id: string; brief: string }) {
      sentActivations.push(message.id);
      return { status: 'delivered' as const, evidence: 'activation delivered' };
    },
    async messageReceipt(_a: ManagedAttempt, message: { id: string; brief: string }) {
      return sentActivations.includes(message.id) ? 'delivered-receipt' : undefined;
    },
    async result(_a: ManagedAttempt) {
      return 'business task result';
    },
    async collect(_a: ManagedAttempt) {
      return 'business task result';
    },
  };

  return {
    config,
    runner,
    get launches() {
      return launches;
    },
    get sentActivations() {
      return sentActivations;
    },
    setReadyReceipt(val: boolean) {
      readyReceipt = val;
    },
    setReadyInit(val: boolean) {
      readyInit = val;
    },
    stopAttempt(id: string) {
      stoppedAttempts.add(id);
    },
    cleanup() {
      rmSync(project, { recursive: true, force: true });
    },
  };
}

const defaultSubject = {
  repository: 'test/repo',
  number: 101,
  kind: 'issue' as const,
  title: 'Unified startup verification',
  body: 'Exercise startup progression',
};

test('Orchestrator: immediate startup ready when provider is synchronous', async () => {
  const f = createFixture();
  try {
    const run = await startRun(f.config, f.runner, defaultSubject, 'agy');
    expect(run.lifecycle).toBe('running');
    expect(run.orchestrator).toBeDefined();
    expect(run.orchestrator?.status).toBe('running');
    expect(startupOutcome(run.orchestrator!)).toBe('pending');
    expect(startupPending(f.config, run.id)).toBe(true);

    const result = await requestManagedStartup(f.config, f.runner, run.id);
    expect(result.outcome).toBe('ready');
    expect(result.attempt?.id).toBe(run.orchestratorId);
    expect(result.attempt?.activation?.status).toBe('delivered');
    expect(f.sentActivations).toEqual([`activate-${run.orchestratorId}`]);
    expect(startupPending(f.config, run.id)).toBe(false);
  } finally {
    f.cleanup();
  }
});

test('Orchestrator: late initialization reports pending until initialized, then ready', async () => {
  const f = createFixture();
  f.setReadyInit(false); // Do not write initialization during runner.start
  try {
    const run = await startRun(f.config, f.runner, defaultSubject, 'agy');
    // Native evidence present, but role initialization not yet completed
    expect(run.lifecycle).toBe('blocked');
    expect(run.orchestrator?.conversation).toBe('native-1');
    expect(run.orchestrator?.activation).toBeUndefined();
    expect(startupOutcome(run.orchestrator!)).toBe('pending');
    expect(startupPending(f.config, run.id)).toBe(true);
    expect(f.sentActivations).toEqual([]);

    // Managed startup request returns pending
    const pendingResult = await requestManagedStartup(f.config, f.runner, run.id);
    expect(pendingResult.outcome).toBe('pending');

    // Late initialization arrives
    initializeRole(run.orchestrator!);

    // Next progression verifies role initialization and delivers activation
    const readyResult = await requestManagedStartup(f.config, f.runner, run.id, { timeoutMs: 1000 });
    expect(readyResult.outcome).toBe('ready');
    expect(readyResult.attempt?.activation?.status).toBe('delivered');
    expect(f.sentActivations).toEqual([`activate-${run.orchestratorId}`]);
    expect(inspectRuns(f.config).runs[0].lifecycle).toBe('running');
    expect(startupPending(f.config, run.id)).toBe(false);
  } finally {
    f.cleanup();
  }
});

test('Orchestrator: failed initialization records error and refuses activation', async () => {
  const f = createFixture();
  f.setReadyInit(false);
  try {
    const run = await startRun(f.config, f.runner, defaultSubject, 'agy');
    expect(run.lifecycle).toBe('blocked');

    // Corrupt initialization evidence (wrong authority)
    const expected = run.orchestrator!.initialization!;
    writeFileSync(
      join(run.orchestrator!.directory, 'initialization.json'),
      JSON.stringify({ ...expected, authority: 'wrong-authority-uuid' }),
    );

    const result = await requestManagedStartup(f.config, f.runner, run.id);
    expect(result.outcome).toBe('pending');
    expect(result.error).toContain('authority');
    expect(run.orchestrator?.activation).toBeUndefined();
    expect(f.sentActivations).toEqual([]);

    // Business dispatch cannot occur because Run lifecycle is blocked
    await expect(
      dispatchStage(f.config, f.runner, {
        runId: run.id,
        authority: run.orchestratorId,
        subject: 'test/repo#101',
        role: 'worker',
        stage: 'implementation',
        inputRevision: 'rev1',
        brief: 'cannot dispatch while orchestrator is uninitialized',
        prerequisites: [],
      }),
    ).rejects.toThrow();
  } finally {
    f.cleanup();
  }
});

test('Orchestrator: missing native startup evidence reports pending and retains occupancy', async () => {
  const f = createFixture();
  f.setReadyReceipt(false);
  try {
    const run = await startRun(f.config, f.runner, defaultSubject, 'agy');
    expect(run.lifecycle).toBe('blocked');
    expect(run.orchestrator?.status).toBe('unknown');
    expect(run.orchestrator?.conversation).toBeUndefined();
    expect(startupOutcome(run.orchestrator!)).toBe('pending');

    const result = await requestManagedStartup(f.config, f.runner, run.id);
    expect(result.outcome).toBe('pending');
    expect(f.sentActivations).toEqual([]);

    // Reconnecting does not launch another orchestrator
    const reconnected = await startRun(f.config, f.runner, defaultSubject, 'agy');
    expect(reconnected.orchestratorId).toBe(run.orchestratorId);
    expect(f.launches).toBe(1);

    // When receipt is now available
    f.setReadyReceipt(true);
    initializeRole(run.orchestrator!);
    const readyResult = await requestManagedStartup(f.config, f.runner, run.id, { timeoutMs: 1000 });
    expect(readyResult.outcome).toBe('ready');
    expect(readyResult.attempt?.conversation).toBe('native-1');
    expect(f.launches).toBe(1); // Never relaunched!
  } finally {
    f.cleanup();
  }
});

test('Orchestrator: interruption between phases reconnects without duplicate launch or double activation', async () => {
  const f = createFixture();
  f.setReadyInit(false);
  try {
    const run = await startRun(f.config, f.runner, defaultSubject, 'agy');
    expect(f.launches).toBe(1);

    // Simulate interruption before role initialization
    await startRun(f.config, f.runner, defaultSubject, 'agy');
    expect(f.launches).toBe(1); // Reconnected original attempt

    // Complete role initialization
    initializeRole(run.orchestrator!);

    // Reconcile once: delivers activation
    await reconcileStartup(f.config, f.runner, run.id);
    expect(f.sentActivations).toHaveLength(1);

    // Simulate caller interruption and re-entry
    await reconcileStartup(f.config, f.runner, run.id);
    expect(f.sentActivations).toHaveLength(1); // Not resent!
    expect(f.launches).toBe(1); // Not relaunched!
  } finally {
    f.cleanup();
  }
});

test('Worker: startup lifecycle progression from reserved to running upon activation', async () => {
  const f = createFixture();
  try {
    const run = await startRun(f.config, f.runner, defaultSubject, 'agy');
    expect(run.lifecycle).toBe('running');

    // Dispatch worker with late initialization
    f.setReadyInit(false);
    const dispatch = await dispatchStage(f.config, f.runner, {
      runId: run.id,
      authority: run.orchestratorId,
      subject: 'test/repo#101',
      role: 'worker',
      stage: 'implementation',
      inputRevision: 'rev1',
      brief: 'Worker task brief',
      prerequisites: [],
    });

    // Worker attempt has native execution evidence, but role initialization is not yet ready
    expect(dispatch.lifecycle).toBe('reserved');
    const workerAttempt = dispatch.attempts[0];
    expect(workerAttempt.conversation).toBe('native-2');
    expect(workerAttempt.status).not.toBe('running');
    expect(startupOutcome(workerAttempt)).toBe('pending');

    // Native startup evidence alone NEVER permits business execution!
    await expect(
      collectBusinessTurn(f.config, f.runner, workerAttempt),
    ).rejects.toThrow(/Attempt startup incomplete/);

    // Managed startup query reports pending
    const pendingWorker = await requestManagedStartup(f.config, f.runner, run.id, {
      dispatchId: dispatch.id,
    });
    expect(pendingWorker.outcome).toBe('pending');

    // Late worker initialization arrives (.epic-status.json + .epic-worklog.md + initialization.json)
    initializeRole(workerAttempt);

    // Request managed startup with deadline: advances to ready
    const readyWorker = await requestManagedStartup(f.config, f.runner, run.id, {
      dispatchId: dispatch.id,
      timeoutMs: 1000,
    });
    expect(readyWorker.outcome).toBe('ready');
    expect(readyWorker.attempt?.activation?.status).toBe('delivered');
    expect(f.sentActivations).toContain(`activate-${workerAttempt.id}`);

    // Dispatch lifecycle is now running
    const updatedDispatch = inspectRuns(f.config).dispatches![0];
    expect(updatedDispatch.lifecycle).toBe('running');

    // Now business operations are permitted
    const result = await collectBusinessTurn(f.config, f.runner, readyWorker.attempt!);
    expect(result).toBe('business task result');
  } finally {
    f.cleanup();
  }
});

test('Worker: failed initialization records error and retains reserved occupancy', async () => {
  const f = createFixture();
  try {
    const run = await startRun(f.config, f.runner, defaultSubject, 'agy');
    f.setReadyInit(false);
    const dispatch = await dispatchStage(f.config, f.runner, {
      runId: run.id,
      authority: run.orchestratorId,
      subject: 'test/repo#101',
      role: 'worker',
      stage: 'implementation',
      inputRevision: 'rev1',
      brief: 'Worker task brief',
      prerequisites: [],
    });

    const workerAttempt = dispatch.attempts[0];
    // Write invalid worker status (invalid phase)
    writeFileSync(
      join(workerAttempt.checkout, '.epic-status.json'),
      JSON.stringify({
        issue: 101,
        phase: 'invalid-phase',
        summary: 'invalid',
        updated_at: new Date().toISOString(),
      }),
    );
    writeFileSync(
      join(workerAttempt.directory, 'initialization.json'),
      JSON.stringify(workerAttempt.initialization),
    );

    const workerResult = await requestManagedStartup(f.config, f.runner, run.id, {
      dispatchId: dispatch.id,
    });
    expect(workerResult.outcome).toBe('pending');
    expect(workerResult.error).toContain('Worker status');
    expect(workerAttempt.activation).toBeUndefined();

    // Business execution remains refused
    await expect(
      collectBusinessTurn(f.config, f.runner, workerAttempt),
    ).rejects.toThrow(/Attempt startup incomplete/);
  } finally {
    f.cleanup();
  }
});

test('Worker: retry advances through unified startup stages', async () => {
  const f = createFixture();
  try {
    const run = await startRun(f.config, f.runner, defaultSubject, 'agy');
    const dispatch = await dispatchStage(f.config, f.runner, {
      runId: run.id,
      authority: run.orchestratorId,
      subject: 'test/repo#101',
      role: 'worker',
      stage: 'implementation',
      inputRevision: 'rev1',
      brief: 'Worker task brief',
      prerequisites: [],
    });

    expect(dispatch.lifecycle).toBe('running');
    const firstAttempt = dispatch.attempts[0];

    // Retry the stage
    f.stopAttempt(firstAttempt.id);
    const retried = await retryStage(
      f.config,
      f.runner,
      dispatch.id,
      run.orchestratorId,
      async (a) => f.runner.stopped(a),
    );

    expect(retried.attempts).toHaveLength(2);
    const retryAttempt = retried.attempts[1];
    expect(retryAttempt.status).toBe('running');
    expect(startupOutcome(retryAttempt)).toBe('pending');

    const retryReady = await requestManagedStartup(f.config, f.runner, run.id, {
      dispatchId: dispatch.id,
    });
    expect(retryReady.outcome).toBe('ready');
    expect(retryReady.attempt?.activation?.status).toBe('delivered');
    expect(f.sentActivations).toEqual([
      `activate-${run.orchestratorId}`,
      `activate-${retryAttempt.id}`,
    ]);
  } finally {
    f.cleanup();
  }
});

test('Process termination during startup transitions outcome to failed', async () => {
  const f = createFixture();
  f.setReadyInit(false);
  try {
    const run = await startRun(f.config, f.runner, defaultSubject, 'agy');
    expect(startupOutcome(run.orchestrator!)).toBe('pending');

    // Process exits/stops
    f.stopAttempt(run.orchestratorId);

    const result = await requestManagedStartup(f.config, f.runner, run.id);
    expect(result.outcome).toBe('failed');
    expect(result.attempt?.startupStopped).toBe(true);
    expect(result.attempt?.status).toBe('unknown');
    expect(inspectRuns(f.config).runs[0].lifecycle).toBe('blocked');
    expect(startupPending(f.config, run.id)).toBe(false);
  } finally {
    f.cleanup();
  }
});
