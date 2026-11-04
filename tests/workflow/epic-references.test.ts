import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { initializeRole } from './initialize-role.js';
import {
  startRun,
  dispatchStage,
  publishStageReceipt,
  acceptStageReceipt,
  referenceRunSubject,
  inspectRuns,
  closeStageEpic,
  canonicalDeliveryFingerprint,
  type StageRequest,
  type RunnerAdapter,
} from '../../packages/core/src/workflow/run/run-driver.js';
import type { FleetConfig } from '../../packages/core/src/workflow/fleet/fleet-config.js';

describe('EPIC scheduling and cross-Run delivery references', () => {
  let project: string;
  let config: FleetConfig;

  const createRunner = (name = 'codex'): RunnerAdapter => ({
    name,
    interactive: true,
    cancellation: true,
    async preflight() {},
    async start(attempt) {
      initializeRole(attempt);
      return { conversation: 'c1', address: 'a1', evidence: 'ack' };
    },
    async send() {
      return { status: 'delivered', evidence: 'ack' };
    },
    async result() {
      return 'result';
    },
    async collect() {
      return 'result';
    },
    async stopped() {
      return true;
    },
    async cancel() {
      return { evidence: 'stopped' };
    },
    async observe() {
      return { status: 'idle', at: new Date().toISOString(), evidence: 'none' };
    },
  });

  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-epic-ref-')));
    mkdirSync(join(project, 'pool'));
    config = {
      file: join(project, '.epic-config.json'),
      project,
      root: join(project, 'pool'),
      slots: [],
      worktrees: true,
      base: 'main',
    };
    writeFileSync(config.file, JSON.stringify({ clone_root: 'pool', local_worktrees: true }));
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  test('EPIC starts with kind: epic and dispatches planning stage with role: epic', async () => {
    const runner = createRunner();
    const epic = await startRun(
      config,
      runner,
      {
        repository: 'owner/repo',
        number: 100,
        kind: 'epic',
        title: 'Epic Objective',
        body: 'Epic Goal',
      },
      'codex',
    );

    expect(epic.subject.kind).toBe('epic');

    // Planning stage dispatch succeeds for kind: 'epic' and role: 'epic'
    const planningDispatch = await dispatchStage(config, runner, {
      runId: epic.id,
      authority: epic.orchestratorId,
      subject: 'owner/repo#100',
      role: 'epic',
      stage: 'planning',
      inputRevision: 'rev1',
      brief: 'Decompose Epic Objective into child issues',
      prerequisites: [],
    });

    expect(planningDispatch.stage).toBe('planning');
    expect(planningDispatch.role).toBe('epic');
    expect(planningDispatch.runId).toBe(epic.id);

    // Planning stage rejects role: 'worker'
    await expect(
      dispatchStage(config, runner, {
        runId: epic.id,
        authority: epic.orchestratorId,
        subject: 'owner/repo#100',
        role: 'worker' as any,
        stage: 'planning',
        inputRevision: 'rev2',
        brief: 'Worker trying planning',
        prerequisites: [],
      }),
    ).rejects.toThrow(/workflow stage planning requires role epic/);

    // Ordinary issue rejects stage: 'planning'
    const issue = await startRun(
      config,
      runner,
      {
        repository: 'owner/repo',
        number: 101,
        kind: 'issue',
        title: 'Ordinary Issue',
        body: 'Issue Goal',
      },
      'codex',
    );

    await expect(
      dispatchStage(config, runner, {
        runId: issue.id,
        authority: issue.orchestratorId,
        subject: 'owner/repo#101',
        role: 'epic',
        stage: 'planning',
        inputRevision: 'rev3',
        brief: 'Planning on issue',
        prerequisites: [],
      }),
    ).rejects.toThrow(/requires an EPIC Run/);
  });

  test('single execution ownership: external reference records consuming reference without duplicate worker or ownership transfer', async () => {
    const runner = createRunner();
    // Standalone Issue Run owns owner/repo#10
    const standalone = await startRun(
      config,
      runner,
      {
        repository: 'owner/repo',
        number: 10,
        kind: 'issue',
        title: 'Child Issue',
        body: 'Child Goal',
      },
      'codex',
    );

    const initialRegistry = inspectRuns(config);
    const initialSubject = initialRegistry.subjects?.find((s) => s.subject === 'owner/repo#10');
    expect(initialSubject).toMatchObject({
      subject: 'owner/repo#10',
      ownerRunId: standalone.id,
      consumingRunIds: [],
    });

    // EPIC Run for owner/repo#1
    const epic = await startRun(
      config,
      runner,
      {
        repository: 'owner/repo',
        number: 1,
        kind: 'epic',
        title: 'Parent Epic',
        body: 'Epic Goal',
      },
      'codex',
    );

    // EPIC references externally owned issue #10
    const ownerRunId = referenceRunSubject(config, epic.id, 'owner/repo#10');
    expect(ownerRunId).toBe(standalone.id);

    // Verify registry state: ownerRunId remains standalone, consumingRunIds contains epic.id
    const updatedRegistry = inspectRuns(config);
    const updatedSubject = updatedRegistry.subjects?.find((s) => s.subject === 'owner/repo#10');
    expect(updatedSubject).toMatchObject({
      subject: 'owner/repo#10',
      ownerRunId: standalone.id,
      consumingRunIds: [epic.id],
    });

    // Idempotent: referencing again does not duplicate consumingRunIds
    referenceRunSubject(config, epic.id, 'owner/repo#10');
    expect(inspectRuns(config).subjects?.find((s) => s.subject === 'owner/repo#10')?.consumingRunIds).toEqual([
      epic.id,
    ]);

    // EPIC cannot launch a duplicate Worker for externally owned issue #10
    await expect(
      dispatchStage(config, runner, {
        runId: epic.id,
        authority: epic.orchestratorId,
        subject: 'owner/repo#10',
        role: 'worker',
        stage: 'implementation',
        inputRevision: 'rev-ext',
        brief: 'EPIC attempting duplicate worker',
        prerequisites: [],
      }),
    ).rejects.toThrow(`Subject owned by Run ${standalone.id}`);

    // Standalone Run CAN dispatch its own worker for owner/repo#10
    const standaloneWorker = await dispatchStage(config, runner, {
      runId: standalone.id,
      authority: standalone.orchestratorId,
      subject: 'owner/repo#10',
      role: 'worker',
      stage: 'implementation',
      inputRevision: 'rev-standalone',
      brief: 'Authoritative worker dispatch',
      prerequisites: [],
    });
    expect(standaloneWorker.runId).toBe(standalone.id);
  });

  test('incomplete external delivery blocks integrated-acceptance', async () => {
    const runner = createRunner();
    const standalone = await startRun(
      config,
      runner,
      {
        repository: 'owner/repo',
        number: 10,
        kind: 'issue',
        title: 'Child Issue',
        body: 'Child Goal',
      },
      'codex',
    );

    const epic = await startRun(
      config,
      runner,
      {
        repository: 'owner/repo',
        number: 1,
        kind: 'epic',
        title: 'Parent Epic',
        body: 'Epic Goal',
      },
      'codex',
    );

    // Run E references child issue 10
    referenceRunSubject(config, epic.id, 'owner/repo#10');

    // Case A: No delivery recorded in registry.deliveries
    await expect(
      dispatchStage(config, runner, {
        runId: epic.id,
        authority: epic.orchestratorId,
        subject: 'owner/repo#1',
        role: 'epic',
        stage: 'integrated-acceptance',
        inputRevision: 'head-rev-1',
        brief: 'Evaluate integrated delivery',
        prerequisites: [],
      }),
    ).rejects.toThrow(/Incomplete delivery for required child owner\/repo#10/);

    // Case B: Worker success / PR merge alone (pullRequests entry exists, but deliveries does not)
    const { updateRunRegistry } = await import('../../packages/core/src/workflow/run/run-driver.js');
    updateRunRegistry(config, (reg) => {
      reg.pullRequests = [
        {
          runId: standalone.id,
          repository: 'owner/repo',
          issue: 10,
          pr: 42,
          evidence: 'pr merged',
          status: 'merged',
          dispatches: [],
        },
      ];
    });

    await expect(
      dispatchStage(config, runner, {
        runId: epic.id,
        authority: epic.orchestratorId,
        subject: 'owner/repo#1',
        role: 'epic',
        stage: 'integrated-acceptance',
        inputRevision: 'head-rev-1',
        brief: 'Evaluate integrated delivery',
        prerequisites: [],
      }),
    ).rejects.toThrow(/Incomplete delivery for required child owner\/repo#10/);

    // Case C: Delivery recorded with status !== 'done' (e.g. 'failed')
    updateRunRegistry(config, (reg) => {
      reg.deliveries = [
        {
          runId: standalone.id,
          repository: 'owner/repo',
          issue: 10,
          pr: 42,
          status: 'failed',
          recorded: true,
          released: true,
          archive: join(project, 'archive'),
          evidence: 'failed run',
          dispatches: [],
        },
      ];
    });

    await expect(
      dispatchStage(config, runner, {
        runId: epic.id,
        authority: epic.orchestratorId,
        subject: 'owner/repo#1',
        role: 'epic',
        stage: 'integrated-acceptance',
        inputRevision: 'head-rev-1',
        brief: 'Evaluate integrated delivery',
        prerequisites: [],
      }),
    ).rejects.toThrow(/Incomplete delivery for required child owner\/repo#10/);

    // Case D: Delivery status === 'done', but not recorded or released or archive missing
    updateRunRegistry(config, (reg) => {
      reg.deliveries = [
        {
          runId: standalone.id,
          repository: 'owner/repo',
          issue: 10,
          pr: 42,
          status: 'done',
          recorded: false,
          released: false,
          evidence: 'incomplete cleanup',
          dispatches: [],
        },
      ];
    });

    await expect(
      dispatchStage(config, runner, {
        runId: epic.id,
        authority: epic.orchestratorId,
        subject: 'owner/repo#1',
        role: 'epic',
        stage: 'integrated-acceptance',
        inputRevision: 'head-rev-1',
        brief: 'Evaluate integrated delivery',
        prerequisites: [],
      }),
    ).rejects.toThrow(/Incomplete delivery for required child owner\/repo#10/);
  });

  test('completed external delivery enables integrated-acceptance and binds canonical delivery fingerprint', async () => {
    const runner = createRunner();
    const standalone = await startRun(
      config,
      runner,
      {
        repository: 'owner/repo',
        number: 10,
        kind: 'issue',
        title: 'Child Issue',
        body: 'Child Goal',
      },
      'codex',
    );

    const epic = await startRun(
      config,
      runner,
      {
        repository: 'owner/repo',
        number: 1,
        kind: 'epic',
        title: 'Parent Epic',
        body: 'Epic Goal',
      },
      'codex',
    );

    referenceRunSubject(config, epic.id, 'owner/repo#10');

    // Create valid archive bundle
    const archivePath = join(project, 'archive');
    mkdirSync(archivePath, { recursive: true });
    writeFileSync(join(archivePath, 'repository.bundle'), 'bundle-content');

    const externalDelivery = {
      runId: standalone.id,
      repository: 'owner/repo',
      issue: 10,
      pr: 42,
      status: 'done',
      recorded: true,
      released: true,
      archive: archivePath,
      checkedHead: 'head-123',
      evidence: 'final records verified',
      dispatches: ['d-external'],
    };

    const { updateRunRegistry } = await import('../../packages/core/src/workflow/run/run-driver.js');
    updateRunRegistry(config, (reg) => {
      reg.deliveries = [externalDelivery];
    });

    // Now dispatchStage for integrated-acceptance succeeds!
    const dispatch = await dispatchStage(config, runner, {
      runId: epic.id,
      authority: epic.orchestratorId,
      subject: 'owner/repo#1',
      role: 'epic',
      stage: 'integrated-acceptance',
      inputRevision: 'head-123',
      brief: 'Evaluate integrated delivery',
      prerequisites: [],
    });
    expect(dispatch.stage).toBe('integrated-acceptance');

    // Setup accepted receipt with satisfied judgment
    const judgmentContent = JSON.stringify({
      satisfied: true,
      criteria: ['All goals delivered'],
      blockers: [],
    });
    const judgmentPath = join(project, 'judgment.json');
    writeFileSync(judgmentPath, judgmentContent);
    const judgmentHash = createHash('sha256').update(judgmentContent).digest('hex');

    updateRunRegistry(config, (reg) => {
      const d = reg.dispatches?.find((x) => x.id === dispatch.id);
      if (d) {
        d.lifecycle = 'accepted';
        d.acceptedReceipt = 'receipt-epic-int';
      }
      reg.receipts = [
        {
          id: 'receipt-epic-int',
          dispatchId: dispatch.id,
          runId: epic.id,
          role: 'epic',
          stage: 'integrated-acceptance',
          provider: 'codex',
          subject: 'owner/repo#1',
          inputRevision: 'head-123',
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

    // Compute canonical fingerprint including external deliveries
    const canonicalVersion = canonicalDeliveryFingerprint('head-123', [externalDelivery]);

    // Human confirmation with wrong fingerprint rejected
    await expect(
      closeStageEpic(
        config,
        epic.id,
        epic.orchestratorId,
        dispatch.id,
        {
          deliveryVersion: 'wrong-fingerprint',
          source: 'human',
          evidence: 'confirmed',
        },
        async () => ({ head: 'head-123', closed: true, evidence: 'closed on github' }),
      ),
    ).rejects.toThrow();

    // Human confirmation with matching canonical fingerprint succeeds
    const closeResult = await closeStageEpic(
      config,
      epic.id,
      epic.orchestratorId,
      dispatch.id,
      {
        deliveryVersion: canonicalVersion,
        source: 'human',
        evidence: 'explicit human approval',
      },
      async () => ({ head: 'head-123', closed: true, evidence: 'closed on github' }),
    );

    expect(closeResult.deliveryVersion).toBe(canonicalVersion);
    expect(closeResult.head).toBe('head-123');

    // Verify Run is transitioned to post_closure_finalization
    const closedRun = inspectRuns(config).runs.find((r) => r.id === epic.id);
    expect(closedRun?.phase).toBe('post_closure_finalization');
    expect(closedRun?.epicClosure).toMatchObject({
      deliveryVersion: canonicalVersion,
      head: 'head-123',
      status: 'closed',
    });
  });
});
