import { test, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  canonicalDeliveryFingerprint,
  closeStageEpic,
  startRun,
  dispatchStage,
  inspectRuns,
  type StageRequest,
  type WorkflowRun,
} from '../../packages/core/src/workflow/run/run-driver.js';
import { loadFleetConfig } from '../../packages/core/src/workflow/fleet/fleet-config.js';
import {
  DemoControl,
  type DemoExecution,
} from '../../packages/core/src/workflow/demo/control.js';
import {
  DemoDelivery,
  type DemoDeliveryAdapter,
} from '../../packages/core/src/workflow/demo/delivery.js';
import type { DemoRound } from '../../packages/core/src/workflow/demo/round.js';
import type { ManagedAttempt } from '../../packages/core/src/workflow/runtime/runtime.js';

interface TestEnv {
  dir: string;
  config: ReturnType<typeof loadFleetConfig>;
  head: string;
  round: DemoRound;
  run: WorkflowRun;
  dispatchId: string;
  deliveries: {
    runId: string;
    repository: string;
    issue: number;
    pr: number;
    status: string;
    recorded: boolean;
    released: boolean;
    archive: string;
    checkedHead: string;
    evidence: string;
    dispatches: string[];
  }[];
}

function createCompletedDeliveryEnvironment(): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), 'demo-closure-test-'));
  const pool = join(dir, 'pool');
  mkdirSync(pool, { recursive: true });
  const configFile = join(dir, '.epic-config.json');
  writeFileSync(
    configFile,
    JSON.stringify({
      clone_root: 'pool',
      local_worktrees: true,
      project: dir,
    }),
  );
  const config = loadFleetConfig(configFile);
  const head = '1111111111111111111111111111111111111111';

  const roundRoot = join(dir, 'round');
  mkdirSync(roundRoot, { recursive: true });
  const round: DemoRound = {
    id: 'round-134',
    root: roundRoot,
    checkout: dir,
    parent: 100,
    repository: { id: 1, owner: 'org', name: 'repo' },
    phase: 'provisioned',
    config: { root: roundRoot, coordinator: 'Coord', brief: 'Demo brief' } as any,
    workflowConfigFile: configFile,
  };

  const runner = {
    name: 'codex',
    interactive: true,
    async preflight() {},
    async start(a: ManagedAttempt) {
      return { conversation: a.id, address: `controlled:${a.id}`, evidence: 'receipt' };
    },
    async stopped() {
      return true;
    },
    async collect() {
      return JSON.stringify({
        satisfied: true,
        criteria: ['both tasks delivered and tested'],
        blockers: [],
      });
    },
  };

  return {
    dir,
    config,
    head,
    round,
    run: null as any,
    dispatchId: '',
    deliveries: [],
  };
}

test('normal Workflow canonicalDeliveryFingerprint matches across request, consent, close and record', () => {
  const head = 'abc123';
  const deliveries = [
    { runId: 'r1', issue: 1, pr: 1, status: 'done', recorded: true, released: true, archive: '/a' },
    { runId: 'r1', issue: 2, pr: 2, status: 'done', recorded: true, released: true, archive: '/b' },
  ];
  const fingerprint1 = canonicalDeliveryFingerprint(head, deliveries);
  const fingerprint2 = canonicalDeliveryFingerprint(head, deliveries);
  expect(fingerprint1).toBe(fingerprint2);
  expect(typeof fingerprint1).toBe('string');
  expect(fingerprint1).toHaveLength(64);

  // Changed relevant delivery invalidates fingerprint
  const changedDeliveries = [
    { runId: 'r1', issue: 1, pr: 1, status: 'done', recorded: true, released: true, archive: '/a' },
    { runId: 'r1', issue: 2, pr: 3, status: 'done', recorded: true, released: true, archive: '/b' },
  ];
  expect(canonicalDeliveryFingerprint(head, changedDeliveries)).not.toBe(fingerprint1);

  // Changed head invalidates fingerprint
  expect(canonicalDeliveryFingerprint('def456', deliveries)).not.toBe(fingerprint1);
});

test('closure request requires current integrated acceptance, displays exact version, and starts evidenced human wait', async () => {
  const root = mkdtempSync(join(tmpdir(), 'demo-request-'));
  const round = { root, id: 'round-req', phase: 'provisioned' as const, config: { root } } as DemoRound;
  let accepted = false;
  let firstReleased = true;
  const head = 'head-sha-1';
  const deliveries = [{ issue: 1 }, { issue: 2 }];
  const version = canonicalDeliveryFingerprint(head, deliveries);

  const adapter: DemoDeliveryAdapter = {
    async inspect() {
      return {
        version,
        children: [1, 2],
        nativeDependency: true,
        firstReleased,
        secondBaseline: true,
        accepted,
      };
    },
  };

  const exec: DemoExecution = {
    stop: async () => true,
  };
  const control = new DemoControl(round, exec);
  await control.arm(10000);

  try {
    const delivery = new DemoDelivery(round, adapter);

    // Request requires current integrated acceptance
    await expect(delivery.request()).rejects.toThrow();

    accepted = true;
    const facts = await delivery.request();
    expect(facts.version).toBe(version);

    // Evidenced human budget pause
    await control.humanWait(`Closure request for round ${round.id} delivery version ${facts.version}`);
    expect(control.status().wait).toBe('human');
    expect(control.status().humanEvidence).toContain(version);

    // Confirm requires explicit true and matching version
    await expect(delivery.confirm(version, false)).rejects.toThrow('confirmation');
    await expect(delivery.confirm('wrong-version', true)).rejects.toThrow('confirmation');

    // Explicit confirmation creates consent bound to version
    const consent = await delivery.confirm(version, true);
    expect(consent.source).toBe('human');
    expect(consent.deliveryVersion).toBe(version);

    // Confirmation resumes only the applicable human wait
    await control.humanResume();
    expect(control.status().wait).toBeUndefined();
    expect(control.status().humanEvidence).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stale version rejection before external side effects and no-consent rejection', async () => {
  const env = createCompletedDeliveryEnvironment();
  try {
    const runner = {
      name: 'codex',
      interactive: true,
      async preflight() {},
      async start(a: ManagedAttempt) {
        return { conversation: a.id, address: `controlled:${a.id}`, evidence: 'receipt' };
      },
      async stopped() {
        return true;
      },
      async collect() {
        return JSON.stringify({
          satisfied: true,
          criteria: ['both tasks delivered and tested'],
          blockers: [],
        });
      },
    };

    const run = await startRun(
      env.config,
      runner,
      { repository: 'org/repo', number: 100, kind: 'epic', title: 'Demo Epic', body: 'Demo body' },
      'codex',
    );

    // Dispatch integrated acceptance
    const input: StageRequest = {
      subject: 'org/repo#100',
      role: 'epic',
      stage: 'integrated-acceptance',
      inputRevision: env.head,
      brief: 'Assess integrated acceptance',
      prerequisites: [],
      runId: run.id,
      authority: run.orchestratorId,
    };
    const dispatch = await dispatchStage(env.config, runner, input);

    // Setup accepted receipt and complete deliveries in registry
    const archivePath = join(env.dir, 'archive');
    mkdirSync(archivePath, { recursive: true });
    writeFileSync(join(archivePath, 'repository.bundle'), 'bundle');

    const deliveries = [
      {
        runId: run.id,
        repository: 'org/repo',
        issue: 101,
        pr: 1,
        status: 'done',
        recorded: true,
        released: true,
        archive: archivePath,
        checkedHead: env.head,
        evidence: 'archive',
        dispatches: ['d1'],
      },
      {
        runId: run.id,
        repository: 'org/repo',
        issue: 102,
        pr: 2,
        status: 'done',
        recorded: true,
        released: true,
        archive: archivePath,
        checkedHead: env.head,
        evidence: 'archive',
        dispatches: ['d2'],
      },
    ];

    const judgmentContent = JSON.stringify({ satisfied: true, criteria: ['pass'], blockers: [] });
    const judgmentPath = join(env.dir, 'judgment.json');
    writeFileSync(judgmentPath, judgmentContent);
    const judgmentHash = createHash('sha256').update(judgmentContent).digest('hex');

    const { updateRunRegistry } = await import('../../packages/core/src/workflow/run/run-driver.js');
    updateRunRegistry(env.config, (reg) => {
      reg.deliveries = deliveries;
      const d = reg.dispatches?.find((x) => x.id === dispatch.id);
      if (d) {
        d.lifecycle = 'accepted';
        d.acceptedReceipt = 'receipt-int';
      }
      reg.receipts = [
        {
          id: 'receipt-int',
          dispatchId: dispatch.id,
          runId: run.id,
          role: 'epic',
          stage: 'integrated-acceptance',
          provider: 'codex',
          subject: 'org/repo#100',
          inputRevision: env.head,
          attemptId: dispatch.attempts[0].id,
          evidence: [
            {
              path: judgmentPath,
              hash: judgmentHash,
            },
          ],
        },
      ];
    });

    const canonicalVersion = canonicalDeliveryFingerprint(env.head, deliveries);

    let externalSideEffectCalled = false;
    const actions = {
      head: () => env.head,
      view: async () => ({ state: 'open' }),
      close: async () => {
        externalSideEffectCalled = true;
      },
    };

    // 1. No consent: missing confirmation or wrong source
    await expect(
      closeStageEpic(
        env.config,
        run.id,
        run.orchestratorId,
        dispatch.id,
        { deliveryVersion: canonicalVersion, source: 'agent' as any, evidence: 'agent claimed' },
        actions,
      ),
    ).rejects.toThrow();
    expect(externalSideEffectCalled).toBe(false);

    // 2. Stale version rejection: confirmation has old version
    await expect(
      closeStageEpic(
        env.config,
        run.id,
        run.orchestratorId,
        dispatch.id,
        { deliveryVersion: 'stale-version-999', source: 'human', evidence: 'operator confirmed old' },
        actions,
      ),
    ).rejects.toThrow();
    expect(externalSideEffectCalled).toBe(false);

    // 3. Changed delivery invalidates old acceptance/consent
    const newHead = '2222222222222222222222222222222222222222';
    const changedActions = {
      head: () => newHead,
      view: async () => ({ state: 'open' }),
      close: async () => {
        externalSideEffectCalled = true;
      },
    };
    await expect(
      closeStageEpic(
        env.config,
        run.id,
        run.orchestratorId,
        dispatch.id,
        { deliveryVersion: canonicalVersion, source: 'human', evidence: 'operator confirmed' },
        changedActions,
      ),
    ).rejects.toThrow();
    expect(externalSideEffectCalled).toBe(false);
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('current consent causes one verified actual close and opens post_closure_finalization', async () => {
  const env = createCompletedDeliveryEnvironment();
  try {
    const runner = {
      name: 'codex',
      interactive: true,
      async preflight() {},
      async start(a: ManagedAttempt) {
        return { conversation: a.id, address: `controlled:${a.id}`, evidence: 'receipt' };
      },
      async stopped() {
        return true;
      },
      async collect() {
        return JSON.stringify({
          satisfied: true,
          criteria: ['both tasks delivered and tested'],
          blockers: [],
        });
      },
    };

    const run = await startRun(
      env.config,
      runner,
      { repository: 'org/repo', number: 100, kind: 'epic', title: 'Demo Epic', body: 'Demo body' },
      'codex',
    );

    const input: StageRequest = {
      subject: 'org/repo#100',
      role: 'epic',
      stage: 'integrated-acceptance',
      inputRevision: env.head,
      brief: 'Assess integrated acceptance',
      prerequisites: [],
      runId: run.id,
      authority: run.orchestratorId,
    };
    const dispatch = await dispatchStage(env.config, runner, input);

    const archivePath = join(env.dir, 'archive');
    mkdirSync(archivePath, { recursive: true });
    writeFileSync(join(archivePath, 'repository.bundle'), 'bundle');

    const deliveries = [
      {
        runId: run.id,
        repository: 'org/repo',
        issue: 101,
        pr: 1,
        status: 'done',
        recorded: true,
        released: true,
        archive: archivePath,
        checkedHead: env.head,
        evidence: 'archive',
        dispatches: ['d1'],
      },
      {
        runId: run.id,
        repository: 'org/repo',
        issue: 102,
        pr: 2,
        status: 'done',
        recorded: true,
        released: true,
        archive: archivePath,
        checkedHead: env.head,
        evidence: 'archive',
        dispatches: ['d2'],
      },
    ];

    const judgmentContent = JSON.stringify({ satisfied: true, criteria: ['pass'], blockers: [] });
    const judgmentPath = join(env.dir, 'judgment.json');
    writeFileSync(judgmentPath, judgmentContent);
    const judgmentHash = createHash('sha256').update(judgmentContent).digest('hex');

    const { updateRunRegistry } = await import('../../packages/core/src/workflow/run/run-driver.js');
    updateRunRegistry(env.config, (reg) => {
      reg.deliveries = deliveries;
      const d = reg.dispatches?.find((x) => x.id === dispatch.id);
      if (d) {
        d.lifecycle = 'accepted';
        d.acceptedReceipt = 'receipt-int';
      }
      reg.receipts = [
        {
          id: 'receipt-int',
          dispatchId: dispatch.id,
          runId: run.id,
          role: 'epic',
          stage: 'integrated-acceptance',
          provider: 'codex',
          subject: 'org/repo#100',
          inputRevision: env.head,
          attemptId: dispatch.attempts[0].id,
          evidence: [
            {
              path: judgmentPath,
              hash: judgmentHash,
            },
          ],
        },
      ];
    });

    const canonicalVersion = canonicalDeliveryFingerprint(env.head, deliveries);

    let issueState = 'open';
    let closeCallCount = 0;
    const actions = {
      head: () => env.head,
      view: async () => ({ state: issueState }),
      close: async () => {
        closeCallCount++;
        issueState = 'closed';
      },
    };

    const consent = {
      deliveryVersion: canonicalVersion,
      source: 'human' as const,
      evidence: 'Operator confirmed via pc demo confirm',
    };

    const result = await closeStageEpic(
      env.config,
      run.id,
      run.orchestratorId,
      dispatch.id,
      consent,
      actions,
    );

    expect(result.deliveryVersion).toBe(canonicalVersion);
    expect(result.head).toBe(env.head);
    expect(closeCallCount).toBe(1);
    expect(issueState).toBe('closed');

    // Run registry records closure and phase post_closure_finalization
    const currentRun = inspectRuns(env.config).runs.find((r) => r.id === run.id)!;
    expect(currentRun.epicClosure?.deliveryVersion).toBe(canonicalVersion);
    expect(currentRun.epicClosure?.confirmed).toBe(consent.evidence);
    expect(currentRun.phase).toBe('post_closure_finalization');
    // Run is still running, not business completed!
    expect(currentRun.lifecycle).toBe('running');

    // Merely observing an already-closed Parent cannot close again
    await expect(
      closeStageEpic(
        env.config,
        run.id,
        run.orchestratorId,
        dispatch.id,
        consent,
        actions,
      ),
    ).rejects.toThrow('already-closed');
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('uncertain external close result is reconciled and retained without blind replay', async () => {
  const env = createCompletedDeliveryEnvironment();
  try {
    const runner = {
      name: 'codex',
      interactive: true,
      async preflight() {},
      async start(a: ManagedAttempt) {
        return { conversation: a.id, address: `controlled:${a.id}`, evidence: 'receipt' };
      },
      async stopped() {
        return true;
      },
      async collect() {
        return JSON.stringify({
          satisfied: true,
          criteria: ['both tasks delivered and tested'],
          blockers: [],
        });
      },
    };

    const run = await startRun(
      env.config,
      runner,
      { repository: 'org/repo', number: 100, kind: 'epic', title: 'Demo Epic', body: 'Demo body' },
      'codex',
    );

    const input: StageRequest = {
      subject: 'org/repo#100',
      role: 'epic',
      stage: 'integrated-acceptance',
      inputRevision: env.head,
      brief: 'Assess integrated acceptance',
      prerequisites: [],
      runId: run.id,
      authority: run.orchestratorId,
    };
    const dispatch = await dispatchStage(env.config, runner, input);

    const archivePath = join(env.dir, 'archive');
    mkdirSync(archivePath, { recursive: true });
    writeFileSync(join(archivePath, 'repository.bundle'), 'bundle');

    const deliveries = [
      {
        runId: run.id,
        repository: 'org/repo',
        issue: 101,
        pr: 1,
        status: 'done',
        recorded: true,
        released: true,
        archive: archivePath,
        checkedHead: env.head,
        evidence: 'archive',
        dispatches: ['d1'],
      },
      {
        runId: run.id,
        repository: 'org/repo',
        issue: 102,
        pr: 2,
        status: 'done',
        recorded: true,
        released: true,
        archive: archivePath,
        checkedHead: env.head,
        evidence: 'archive',
        dispatches: ['d2'],
      },
    ];

    const judgmentContent = JSON.stringify({ satisfied: true, criteria: ['pass'], blockers: [] });
    const judgmentPath = join(env.dir, 'judgment.json');
    writeFileSync(judgmentPath, judgmentContent);
    const judgmentHash = createHash('sha256').update(judgmentContent).digest('hex');

    const { updateRunRegistry } = await import('../../packages/core/src/workflow/run/run-driver.js');
    updateRunRegistry(env.config, (reg) => {
      reg.deliveries = deliveries;
      const d = reg.dispatches?.find((x) => x.id === dispatch.id);
      if (d) {
        d.lifecycle = 'accepted';
        d.acceptedReceipt = 'receipt-int';
      }
      reg.receipts = [
        {
          id: 'receipt-int',
          dispatchId: dispatch.id,
          runId: run.id,
          role: 'epic',
          stage: 'integrated-acceptance',
          provider: 'codex',
          subject: 'org/repo#100',
          inputRevision: env.head,
          attemptId: dispatch.attempts[0].id,
          evidence: [
            {
              path: judgmentPath,
              hash: judgmentHash,
            },
          ],
        },
      ];
    });

    const canonicalVersion = canonicalDeliveryFingerprint(env.head, deliveries);
    const consent = {
      deliveryVersion: canonicalVersion,
      source: 'human' as const,
      evidence: 'Operator confirmed',
    };

    // Scenario A: close throws network timeout, but issue actually became closed -> reconciled!
    let closeAttempts = 0;
    let issueState = 'open';
    const reconcilingActions = {
      head: () => env.head,
      view: async () => ({ state: issueState }),
      close: async () => {
        closeAttempts++;
        issueState = 'closed'; // GitHub actually processed it despite network timeout
        throw new Error('ETIMEDOUT: network glitch while closing');
      },
    };

    const result = await closeStageEpic(
      env.config,
      run.id,
      run.orchestratorId,
      dispatch.id,
      consent,
      reconcilingActions,
    );
    expect(result.deliveryVersion).toBe(canonicalVersion);
    expect(closeAttempts).toBe(1); // Never blindly replayed!

    const currentRun = inspectRuns(env.config).runs.find((r) => r.id === run.id)!;
    expect(currentRun.epicClosure?.deliveryVersion).toBe(canonicalVersion);

    // Scenario B: close throws error and issue remained open -> retained failure, no blind replay
    // Reset run closure for testing scenario B
    updateRunRegistry(env.config, (reg) => {
      const r = reg.runs.find((x) => x.id === run.id)!;
      delete r.epicClosure;
      delete r.phase;
    });

    let failingAttempts = 0;
    const failingActions = {
      head: () => env.head,
      view: async () => ({ state: 'open' }),
      close: async () => {
        failingAttempts++;
        throw new Error('500 Internal Server Error from GitHub');
      },
    };

    await expect(
      closeStageEpic(
        env.config,
        run.id,
        run.orchestratorId,
        dispatch.id,
        consent,
        failingActions,
      ),
    ).rejects.toThrow('500 Internal Server Error');
    expect(failingAttempts).toBe(1); // Not blindly replayed
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('pc demo close command is removed and routing goes through pc workflow orchestrator close-epic', async () => {
  const { Command } = await import('commander');
  const { registerDemoCommands } = await import('../../packages/cli/src/commands/demo.js');

  const demoProgram = new Command();
  registerDemoCommands(demoProgram);
  const demoCmd = demoProgram.commands.find((c) => c.name() === 'demo');
  expect(demoCmd).toBeDefined();

  // "close" must not exist under pc demo
  const closeSubcmd = demoCmd!.commands.find((c) => c.name() === 'close');
  expect(closeSubcmd).toBeUndefined();

  // "closure-request" and "confirm" must exist
  expect(demoCmd!.commands.find((c) => c.name() === 'closure-request')).toBeDefined();
  expect(demoCmd!.commands.find((c) => c.name() === 'confirm')).toBeDefined();
});

