import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoRounds, type DemoAdapter, type DemoConfig } from '../../tools/demo/round.js';
import { DemoControl, type DemoExecution } from '../../tools/demo/control.js';
import { DemoDelivery, type DemoDeliveryAdapter, type DemoDeliverySnapshot } from '../../tools/demo/delivery.js';
import {
  startRun,
  dispatchStage,
  inspectRuns,
  recoverRun,
  retryStage,
  updateRunRegistry,
  type StageRequest,
} from '../../packages/core/src/workflow/run/run-driver.js';
import { reconcileStartup } from '../../packages/core/src/workflow/run/startup.js';
import type { ManagedAttempt } from '../../packages/core/src/workflow/runtime/runtime.js';

function setupDemoRoundFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-demo-gate1-test-')));
  const remote = new Map<string, { id: number; owner: string; name: string }>();
  const adapter: DemoAdapter = {
    check: async () => {},
    repository: async (owner, name) => remote.get(`${owner}/${name}`) ?? null,
    createRepository: async (owner, name) => {
      const repo = { id: 42, owner, name };
      remote.set(`${owner}/${name}`, repo);
      return repo;
    },
    initialize: async (_repository, checkout) => {
      mkdirSync(checkout);
      return 'a'.repeat(40);
    },
    createParent: async () => 1,
  };
  const config: DemoConfig = {
    root,
    owner: 'testowner',
    prefix: 'demo-',
    coordinator: 'test-coord',
    brief: 'Test brief evidence',
  };
  return { root, adapter, config };
}

test('Criterion 1 & 3 & 4: Automatic Gate 1 verifies Parent, exact children, dependency direction, no extra tasks, and armed round', async () => {
  const { root, adapter, config } = setupDemoRoundFixture();
  const execution: DemoExecution = {
    watch() {},
    async stop() {
      return true;
    },
  };

  try {
    const rounds = new DemoRounds(config, adapter);
    const round = await rounds.provision(true);
    const control = new DemoControl(round, execution);
    await control.arm(10000);

    const fleetConfig = {
      file: round.workflowConfigFile,
      project: round.checkout,
      root: round.worktrees,
      slots: [],
      worktrees: true,
      base: 'main',
      demo: {
        round: round.id,
        config: round.demoConfigFile,
      },
    };

    const runner = {
      interactive: true,
      name: 'agy',
      automaticStartup: true,
      async preflight() {},
      async start(a: ManagedAttempt) {
        return { conversation: `conv-${a.id}`, address: `tmux:${a.id}`, evidence: `ack-${a.id}` };
      },
      async stopped() {
        return false;
      },
    };

    const subject = {
      repository: `testowner/demo-${round.id}`,
      number: 1,
      kind: 'epic' as const,
      title: 'Demo EPIC',
      body: 'Epic body',
    };

    const run = await startRun(fleetConfig, runner, subject, 'agy', round.requirements);

    // Mock Delivery Adapter with valid native facts: exactly two children (2 and 3), child 3 blocked by child 2
    let children = [2, 3];
    let nativeDep = true;
    let parentValid = true;
    let noExtraTasks = true;

    const deliveryAdapter: DemoDeliveryAdapter = {
      async inspect(): Promise<DemoDeliverySnapshot> {
        return {
          version: 'v1',
          children,
          nativeDependency: nativeDep,
          firstReleased: false,
          secondBaseline: false,
          accepted: false,
          task1: 2,
          task2: 3,
          parentValid,
          noExtraTasks,
        };
      },
      async close() {},
    };

    const delivery = new DemoDelivery(round, deliveryAdapter);

    // Invoke Gate 1
    const gateResult = await delivery.gate('worker1');
    expect(gateResult.children).toEqual([2, 3]);
    expect(gateResult.nativeDependency).toBe(true);

    // Verify durable authorization was issued
    const authPath = join(round.root, 'gate-authorization.json');
    expect(existsSync(authPath)).toBe(true);
    const auth = JSON.parse(readFileSync(authPath, 'utf8'));
    expect(auth.roundId).toBe(round.id);
    expect(auth.runId).toBe(run.id);
    expect(auth.issue).toBe(2);
    expect(auth.claimed).toBe(false);

    // Verify durable boundary evidence was recorded
    const boundaryPath = join(round.root, 'delivery-boundaries.jsonl');
    expect(existsSync(boundaryPath)).toBe(true);
    const boundaries = readFileSync(boundaryPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(boundaries.length).toBe(1);
    expect(boundaries[0].stage).toBe('worker1');
    expect(boundaries[0].pass).toBe(true);

    // Worker 1 can now be dispatched
    const worker1Dispatch = await dispatchStage(fleetConfig, runner, {
      runId: run.id,
      authority: run.orchestratorId,
      subject: `${subject.repository}#2`,
      role: 'worker',
      stage: 'implementation',
      inputRevision: 'rev-1',
      brief: 'Implement TSV generator',
      prerequisites: [],
    });
    expect(worker1Dispatch.id).toBeDefined();

    // The authorization is now claimed
    const updatedAuth = JSON.parse(readFileSync(authPath, 'utf8'));
    expect(updatedAuth.claimed).toBe(true);

    // Worker 2 remains blocked!
    await expect(
      dispatchStage(fleetConfig, runner, {
        runId: run.id,
        authority: run.orchestratorId,
        subject: `${subject.repository}#3`,
        role: 'worker',
        stage: 'implementation',
        inputRevision: 'rev-1',
        brief: 'Implement summarizer',
        prerequisites: [],
      }),
    ).rejects.toThrow(/Gate authorization is for issue #2, cannot launch/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Criterion 4 & 7: Failed Gate stops round, retains evidence, and prevents Worker launch', async () => {
  const { root, adapter, config } = setupDemoRoundFixture();
  const execution: DemoExecution = {
    watch() {},
    async stop() {
      return true;
    },
  };

  try {
    const rounds = new DemoRounds(config, adapter);
    const round = await rounds.provision(true);
    const control = new DemoControl(round, execution);
    await control.arm(10000);

    const fleetConfig = {
      file: round.workflowConfigFile,
      project: round.checkout,
      root: round.worktrees,
      slots: [],
      worktrees: true,
      base: 'main',
      demo: {
        round: round.id,
        config: round.demoConfigFile,
      },
    };

    const runner = {
      interactive: true,
      name: 'agy',
      automaticStartup: true,
      async preflight() {},
      async start(a: ManagedAttempt) {
        return { conversation: `conv-${a.id}`, address: `tmux:${a.id}`, evidence: `ack-${a.id}` };
      },
      async stopped() {
        return false;
      },
    };

    const subject = {
      repository: `testowner/demo-${round.id}`,
      number: 1,
      kind: 'epic' as const,
      title: 'Demo EPIC',
      body: 'Epic body',
    };

    const run = await startRun(fleetConfig, runner, subject, 'agy', round.requirements);

    // Invalid facts: 3 children instead of 2 (extra task violation)
    const deliveryAdapter: DemoDeliveryAdapter = {
      async inspect(): Promise<DemoDeliverySnapshot> {
        return {
          version: 'v1',
          children: [2, 3, 4],
          nativeDependency: false,
          firstReleased: false,
          secondBaseline: false,
          accepted: false,
          noExtraTasks: false,
          extraTasks: [4],
        };
      },
      async close() {},
    };

    const delivery = new DemoDelivery(round, deliveryAdapter);

    // Gate 1 must reject and stop the round
    await expect(delivery.gate('worker1')).rejects.toThrow(/Gate 1 verification failed/i);

    // Verify round is stopped
    expect(control.status().stopped).toBe(true);

    // Verify boundary was recorded as failure
    const boundaryPath = join(round.root, 'delivery-boundaries.jsonl');
    const boundaries = readFileSync(boundaryPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(boundaries.at(-1)?.pass).toBe(false);

    // Worker 1 cannot launch (round is stopped due to failed Gate 1)
    await expect(
      dispatchStage(fleetConfig, runner, {
        runId: run.id,
        authority: run.orchestratorId,
        subject: `${subject.repository}#2`,
        role: 'worker',
        stage: 'implementation',
        inputRevision: 'rev-1',
        brief: 'Implement TSV generator',
        prerequisites: [],
      }),
    ).rejects.toThrow(/stopped or expired|Gate 1 authorization required/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Criterion 2 & 10: Stable identity under reordered children (GitHub array order independence)', async () => {
  const { root, adapter, config } = setupDemoRoundFixture();
  const execution: DemoExecution = {
    watch() {},
    async stop() {
      return true;
    },
  };

  try {
    const rounds = new DemoRounds(config, adapter);
    const round = await rounds.provision(true);
    const control = new DemoControl(round, execution);
    await control.arm(10000);

    const fleetConfig = {
      file: round.workflowConfigFile,
      project: round.checkout,
      root: round.worktrees,
      slots: [],
      worktrees: true,
      base: 'main',
      demo: {
        round: round.id,
        config: round.demoConfigFile,
      },
    };

    const runner = {
      interactive: true,
      name: 'agy',
      automaticStartup: true,
      async preflight() {},
      async start(a: ManagedAttempt) {
        return { conversation: `conv-${a.id}`, address: `tmux:${a.id}`, evidence: `ack-${a.id}` };
      },
      async stopped() {
        return false;
      },
    };

    const subject = {
      repository: `testowner/demo-${round.id}`,
      number: 1,
      kind: 'epic' as const,
      title: 'Demo EPIC',
      body: 'Epic body',
    };

    const run = await startRun(fleetConfig, runner, subject, 'agy', round.requirements);

    // Reordered children: GitHub returns [3, 2] instead of [2, 3]!
    // But child 3 is blocked by child 2, so child 2 is Task 1 and child 3 is Task 2!
    const deliveryAdapter: DemoDeliveryAdapter = {
      async inspect(): Promise<DemoDeliverySnapshot> {
        return {
          version: 'v1',
          children: [3, 2], // REORDERED
          nativeDependency: true,
          firstReleased: false,
          secondBaseline: false,
          accepted: false,
          task1: 2,
          task2: 3,
        };
      },
      async close() {},
    };

    const delivery = new DemoDelivery(round, deliveryAdapter);
    await delivery.gate('worker1');

    // Verify task identities were persisted stably
    const tasksPath = join(round.root, 'demo-tasks.json');
    expect(existsSync(tasksPath)).toBe(true);
    const tasks = JSON.parse(readFileSync(tasksPath, 'utf8'));
    expect(tasks.task1).toBe(2);
    expect(tasks.task2).toBe(3);

    // Authorization must be for Task 1 (issue #2), NOT issue #3
    const auth = JSON.parse(readFileSync(join(round.root, 'gate-authorization.json'), 'utf8'));
    expect(auth.issue).toBe(2);

    // Dispatching Worker for Task 1 succeeds
    const dispatch1 = await dispatchStage(fleetConfig, runner, {
      runId: run.id,
      authority: run.orchestratorId,
      subject: `${subject.repository}#2`,
      role: 'worker',
      stage: 'implementation',
      inputRevision: 'rev-1',
      brief: 'Implement TSV generator',
      prerequisites: [],
    });
    expect(dispatch1.id).toBeDefined();

    // Dispatching Worker for Task 2 is rejected
    await expect(
      dispatchStage(fleetConfig, runner, {
        runId: run.id,
        authority: run.orchestratorId,
        subject: `${subject.repository}#3`,
        role: 'worker',
        stage: 'implementation',
        inputRevision: 'rev-1',
        brief: 'Implement summarizer',
        prerequisites: [],
      }),
    ).rejects.toThrow(/Gate authorization is for issue #2, cannot launch/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Criterion 5 & 10: One authorized launch; cannot reuse claimed authorization for another launch', async () => {
  const { root, adapter, config } = setupDemoRoundFixture();
  const execution: DemoExecution = {
    watch() {},
    async stop() {
      return true;
    },
  };

  try {
    const rounds = new DemoRounds(config, adapter);
    const round = await rounds.provision(true);
    const control = new DemoControl(round, execution);
    await control.arm(10000);

    const fleetConfig = {
      file: round.workflowConfigFile,
      project: round.checkout,
      root: round.worktrees,
      slots: [],
      worktrees: true,
      base: 'main',
      demo: {
        round: round.id,
        config: round.demoConfigFile,
      },
    };

    let launches = 0;
    const runner = {
      interactive: true,
      name: 'agy',
      automaticStartup: true,
      async preflight() {},
      async start(a: ManagedAttempt) {
        launches++;
        return { conversation: `conv-${a.id}`, address: `tmux:${a.id}`, evidence: `ack-${a.id}` };
      },
      async stopped() {
        return false;
      },
    };

    const subject = {
      repository: `testowner/demo-${round.id}`,
      number: 1,
      kind: 'epic' as const,
      title: 'Demo EPIC',
      body: 'Epic body',
    };

    const run = await startRun(fleetConfig, runner, subject, 'agy', round.requirements);

    const deliveryAdapter: DemoDeliveryAdapter = {
      async inspect(): Promise<DemoDeliverySnapshot> {
        return {
          version: 'v1',
          children: [2, 3],
          nativeDependency: true,
          firstReleased: false,
          secondBaseline: false,
          accepted: false,
          task1: 2,
          task2: 3,
        };
      },
      async close() {},
    };

    const delivery = new DemoDelivery(round, deliveryAdapter);
    await delivery.gate('worker1');

    // Launch 1 succeeds
    await dispatchStage(fleetConfig, runner, {
      runId: run.id,
      authority: run.orchestratorId,
      subject: `${subject.repository}#2`,
      role: 'worker',
      stage: 'implementation',
      inputRevision: 'rev-1',
      brief: 'Implement TSV generator',
      prerequisites: [],
    });
    // One launch for orchestrator + one for worker
    expect(launches).toBe(2);

    // Attempting a second worker launch with the same claimed authorization is rejected
    await expect(
      dispatchStage(fleetConfig, runner, {
        runId: run.id,
        authority: run.orchestratorId,
        subject: `${subject.repository}#2`,
        role: 'worker',
        stage: 'implementation-retry',
        inputRevision: 'rev-2',
        brief: 'Retry TSV generator',
        prerequisites: [],
      }),
    ).rejects.toThrow(/Gate authorization already claimed/i);

    // Launches count did not increase
    expect(launches).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Criterion 6 & 10: Uncertainty after claiming authorization reconciles without relaunch', async () => {
  const { root, adapter, config } = setupDemoRoundFixture();
  const execution: DemoExecution = {
    watch() {},
    async stop() {
      return true;
    },
  };

  try {
    const rounds = new DemoRounds(config, adapter);
    const round = await rounds.provision(true);
    const control = new DemoControl(round, execution);
    await control.arm(10000);

    const fleetConfig = {
      file: round.workflowConfigFile,
      project: round.checkout,
      root: round.worktrees,
      slots: [],
      worktrees: true,
      base: 'main',
      demo: {
        round: round.id,
        config: round.demoConfigFile,
      },
    };

    let workerLaunches = 0;
    let failWorkerLaunch = true;
    let attemptToRecover: ManagedAttempt | undefined;

    const runner = {
      interactive: true,
      name: 'agy',
      automaticStartup: true,
      async preflight() {},
      async start(a: ManagedAttempt) {
        if (a.role === 'worker') {
          workerLaunches++;
          attemptToRecover = a;
          if (failWorkerLaunch) {
            throw new Error('Network timeout during worker spawn');
          }
        }
        return { conversation: `conv-${a.id}`, address: `tmux:${a.id}`, evidence: `ack-${a.id}` };
      },
      async recoverReceipt(a: ManagedAttempt) {
        return { conversation: `conv-${a.id}`, address: `tmux:${a.id}`, evidence: `ack-${a.id}` };
      },
      async stopped() {
        return false;
      },
    };

    const subject = {
      repository: `testowner/demo-${round.id}`,
      number: 1,
      kind: 'epic' as const,
      title: 'Demo EPIC',
      body: 'Epic body',
    };

    const run = await startRun(fleetConfig, runner, subject, 'agy', round.requirements);

    const deliveryAdapter: DemoDeliveryAdapter = {
      async inspect(): Promise<DemoDeliverySnapshot> {
        return {
          version: 'v1',
          children: [2, 3],
          nativeDependency: true,
          firstReleased: false,
          secondBaseline: false,
          accepted: false,
          task1: 2,
          task2: 3,
        };
      },
      async close() {},
    };

    const delivery = new DemoDelivery(round, deliveryAdapter);
    await delivery.gate('worker1');

    // Launch worker - runner.start throws, producing uncertain status ('unknown')
    const dispatch = await dispatchStage(fleetConfig, runner, {
      runId: run.id,
      authority: run.orchestratorId,
      subject: `${subject.repository}#2`,
      role: 'worker',
      stage: 'implementation',
      inputRevision: 'rev-1',
      brief: 'Implement TSV generator',
      prerequisites: [],
    });

    expect(workerLaunches).toBe(1);
    expect(dispatch.attempts[0].status).toBe('unknown');

    // Authorization was claimed on disk BEFORE runner.start was called
    const auth = JSON.parse(readFileSync(join(round.root, 'gate-authorization.json'), 'utf8'));
    expect(auth.claimed).toBe(true);

    // Another spawn is strictly rejected because authorization is already claimed
    await expect(
      dispatchStage(fleetConfig, runner, {
        runId: run.id,
        authority: run.orchestratorId,
        subject: `${subject.repository}#2`,
        role: 'worker',
        stage: 'implementation',
        inputRevision: 'rev-1',
        brief: 'Implement TSV generator',
        prerequisites: [],
      }),
    ).rejects.toThrow(/Gate authorization already claimed/i);

    expect(workerLaunches).toBe(1);

    // Reconciliation reconciles the existing attempt without spawning another worker
    failWorkerLaunch = false;
    const reconciled = await reconcileStartup(fleetConfig, runner, run.id);
    expect(workerLaunches).toBe(1); // No new worker spawned!
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Criterion 7: Prohibits stage retries and replacement attempts in demo runs', async () => {
  const { root, adapter, config } = setupDemoRoundFixture();
  const execution: DemoExecution = {
    watch() {},
    async stop() {
      return true;
    },
  };

  try {
    const rounds = new DemoRounds(config, adapter);
    const round = await rounds.provision(true);
    const control = new DemoControl(round, execution);
    await control.arm(10000);

    const fleetConfig = {
      file: round.workflowConfigFile,
      project: round.checkout,
      root: round.worktrees,
      slots: [],
      worktrees: true,
      base: 'main',
      demo: {
        round: round.id,
        config: round.demoConfigFile,
      },
    };

    const runner = {
      interactive: true,
      name: 'agy',
      automaticStartup: true,
      async preflight() {},
      async start(a: ManagedAttempt) {
        return { conversation: `conv-${a.id}`, address: `tmux:${a.id}`, evidence: `ack-${a.id}` };
      },
      async stopped() {
        return true;
      },
    };

    const subject = {
      repository: `testowner/demo-${round.id}`,
      number: 1,
      kind: 'epic' as const,
      title: 'Demo EPIC',
      body: 'Epic body',
    };

    const run = await startRun(fleetConfig, runner, subject, 'agy', round.requirements);

    const deliveryAdapter: DemoDeliveryAdapter = {
      async inspect(): Promise<DemoDeliverySnapshot> {
        return {
          version: 'v1',
          children: [2, 3],
          nativeDependency: true,
          firstReleased: false,
          secondBaseline: false,
          accepted: false,
          task1: 2,
          task2: 3,
        };
      },
      async close() {},
    };

    const delivery = new DemoDelivery(round, deliveryAdapter);
    await delivery.gate('worker1');

    const workerDispatch = await dispatchStage(fleetConfig, runner, {
      runId: run.id,
      authority: run.orchestratorId,
      subject: `${subject.repository}#2`,
      role: 'worker',
      stage: 'implementation',
      inputRevision: 'rev-1',
      brief: 'Implement TSV generator',
      prerequisites: [],
    });

    // Stage retry must be prohibited for demo Runs
    await expect(
      retryStage(fleetConfig, runner, workerDispatch.id, run.orchestratorId),
    ).rejects.toThrow(/Stage retries prohibited for demo-constrained Runs/i);

    // Replacement orchestrator must be rejected
    await expect(
      recoverRun(fleetConfig, runner, run.id, { replaceOrchestrator: true, stopped: async () => true }),
    ).rejects.toThrow(/Replacement Orchestrator not authorized for demo-constrained Run/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Criterion 8: Task 1 delivery allows normal final-records continuation and normal delivery flow', async () => {
  const { root, adapter, config } = setupDemoRoundFixture();
  const execution: DemoExecution = {
    watch() {},
    async stop() {
      return true;
    },
  };

  try {
    const rounds = new DemoRounds(config, adapter);
    const round = await rounds.provision(true);
    const control = new DemoControl(round, execution);
    await control.arm(10000);

    const fleetConfig = {
      file: round.workflowConfigFile,
      project: round.checkout,
      root: round.worktrees,
      slots: [],
      worktrees: true,
      base: 'main',
      demo: {
        round: round.id,
        config: round.demoConfigFile,
      },
    };

    const runner = {
      interactive: true,
      name: 'agy',
      automaticStartup: true,
      async preflight() {},
      async start(a: ManagedAttempt) {
        return { conversation: `conv-${a.id}`, address: `tmux:${a.id}`, evidence: `ack-${a.id}` };
      },
      async stopped() {
        return true;
      },
    };

    const subject = {
      repository: `testowner/demo-${round.id}`,
      number: 1,
      kind: 'epic' as const,
      title: 'Demo EPIC',
      body: 'Epic body',
    };

    const run = await startRun(fleetConfig, runner, subject, 'agy', round.requirements);

    const deliveryAdapter: DemoDeliveryAdapter = {
      async inspect(): Promise<DemoDeliverySnapshot> {
        return {
          version: 'v1',
          children: [2, 3],
          nativeDependency: true,
          firstReleased: false,
          secondBaseline: false,
          accepted: false,
          task1: 2,
          task2: 3,
        };
      },
      async close() {},
    };

    const delivery = new DemoDelivery(round, deliveryAdapter);
    await delivery.gate('worker1');

    // 1. Implementation stage (worker)
    const impl = await dispatchStage(fleetConfig, runner, {
      runId: run.id,
      authority: run.orchestratorId,
      subject: `${subject.repository}#2`,
      role: 'worker',
      stage: 'implementation',
      inputRevision: 'rev-1',
      brief: 'Implement TSV generator',
      prerequisites: [],
    });
    expect(impl.id).toBeDefined();

    updateRunRegistry(fleetConfig, (registry) => {
      const d = registry.dispatches?.find((x) => x.id === impl.id);
      if (d) d.lifecycle = 'accepted';
    });

    // 2. PR Quality (landing)
    const quality = await dispatchStage(fleetConfig, runner, {
      runId: run.id,
      authority: run.orchestratorId,
      subject: `${subject.repository}#2`,
      role: 'landing',
      stage: 'pr-quality',
      inputRevision: 'rev-1',
      brief: 'Run quality checks',
      prerequisites: [],
    });
    expect(quality.id).toBeDefined();

    updateRunRegistry(fleetConfig, (registry) => {
      const d = registry.dispatches?.find((x) => x.id === quality.id);
      if (d) d.lifecycle = 'accepted';
    });

    // 3. PR Merge (landing)
    const merge = await dispatchStage(fleetConfig, runner, {
      runId: run.id,
      authority: run.orchestratorId,
      subject: `${subject.repository}#2`,
      role: 'landing',
      stage: 'pr-merge',
      inputRevision: 'rev-1',
      brief: 'Merge PR',
      prerequisites: [],
    });
    expect(merge.id).toBeDefined();

    updateRunRegistry(fleetConfig, (registry) => {
      const d = registry.dispatches?.find((x) => x.id === merge.id);
      if (d) d.lifecycle = 'accepted';
    });

    // 4. Normal continuation: final-records (worker) for the authorized task 1 is permitted
    const finalRecords = await dispatchStage(fleetConfig, runner, {
      runId: run.id,
      authority: run.orchestratorId,
      subject: `${subject.repository}#2`,
      role: 'worker',
      stage: 'final-records',
      inputRevision: 'merged-pr-1',
      brief: 'Record final results',
      prerequisites: [],
    });
    expect(finalRecords.id).toBeDefined();

    updateRunRegistry(fleetConfig, (registry) => {
      const d = registry.dispatches?.find((x) => x.id === finalRecords.id);
      if (d) d.lifecycle = 'accepted';
    });

    // 5. Preservation & cleanup (landing)
    const cleanup = await dispatchStage(fleetConfig, runner, {
      runId: run.id,
      authority: run.orchestratorId,
      subject: `${subject.repository}#2`,
      role: 'landing',
      stage: 'preservation-cleanup',
      inputRevision: 'merged-pr-1',
      brief: 'Preserve and cleanup',
      prerequisites: [],
    });
    expect(cleanup.id).toBeDefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
