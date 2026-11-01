import { createHash } from 'node:crypto';
import { stateDirectory } from '../../packages/core/src/workflow/handoff.js';
import { readDashboardFleet } from '../../packages/core/src/workflow/dashboard.js';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  startRun,
  sendStageMessage,
  releaseAcceptedExecution,
  collectBusinessTurn,
  acceptValidatedBusinessTurns,
  orchestratorForSubject,
  referenceRunSubject,
  inspectRuns,
  dispatchStage,
  publishStageReceipt,
  acceptStageReceipt,
  retryStage,
  recoverRun,
  setRemediationLimit,
  updateRunRegistry,
} from '../../packages/core/src/workflow/run-driver.js';

test('intake reconnects an acknowledged Run and rejects conflicting ownership without launching', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-run-')));
  mkdirSync(join(project, 'pool'));
  const config = {
    file: join(project, '.epic-config.json'),
    project,
    root: join(project, 'pool'),
    slots: [],
    worktrees: true,
    base: 'main',
  };
  let launches = 0;
  let verifiedStopped = true;
  const runner = {
    interactive: true,
    name: 'codex',
    async stopped() {
      return verifiedStopped;
    },
    async preflight() {},
    async start() {
      launches++;
      return { conversation: 'session', address: 'tmux:verified', evidence: 'ack' };
    },
  };
  const subject = {
    repository: 'owner/repo',
    number: 7,
    kind: 'issue' as const,
    title: 'task',
    body: 'deliver',
  };
  try {
    writeFileSync(config.file, JSON.stringify({ clone_root: 'pool', local_worktrees: true }));
    const runtime = stateDirectory(
      config,
      '.runtime',
      createHash('sha256').update(config.file).digest('hex'),
    );
    mkdirSync(runtime, { recursive: true });
    writeFileSync(
      join(runtime, ['con', 'ductor.json'].join('')),
      JSON.stringify({ status: 'running' }),
    );
    expect(() => orchestratorForSubject(config, subject.repository, 7)).toThrow(
      'workflow orchestrator start 7',
    );
    // A print/exec adapter must fail before reserving ownership or launching a role.
    await expect(
      startRun(config, { ...runner, interactive: false }, subject, 'codex'),
    ).rejects.toThrow(/interactive/);
    expect(launches).toBe(0);
    const first = await startRun(config, runner, subject, 'codex');
    expect(orchestratorForSubject(config, subject.repository, 7).runner).toBe('codex');
    updateRunRegistry(config, (registry) => {
      registry.runs[0].provider = 'unsupported';
    });
    expect(() => orchestratorForSubject(config, subject.repository, 7)).toThrow(
      'Unsupported Run provider',
    );
    updateRunRegistry(config, (registry) => {
      registry.runs[0].provider = 'claude';
    });
    expect(() => orchestratorForSubject(config, subject.repository, 7)).toThrow(
      'Run provider mismatch',
    );
    updateRunRegistry(config, (registry) => {
      registry.runs[0].provider = 'codex';
    });
    expect(first.orchestrator?.status).toBe('running');
    expect((await startRun(config, runner, subject, 'codex')).id).toBe(first.id);
    const other = await startRun(
      config,
      { ...runner, name: 'claude' },
      { ...subject, number: 8 },
      'claude',
    );
    expect(other.orchestratorId).not.toBe(first.orchestratorId);
    expect(launches).toBe(2);
    const snapshot = await readDashboardFleet({ id: 'fleet', config: config.file });
    expect(snapshot.tasks.find((task) => task.runId === first.id)?.orchestratorId).toBe(
      first.orchestratorId,
    );
    expect(snapshot.tasks.find((task) => task.runId === first.id)?.executionEvidence).toMatchObject(
      {
        attempts: [{ id: first.orchestratorId, conversation: 'session', execution: 'unknown' }],
        acceptance: 'unknown',
      },
    );
    const beforeRead = JSON.stringify(inspectRuns(config));
    await readDashboardFleet({ id: 'fleet', config: config.file });
    expect(JSON.stringify(inspectRuns(config))).toBe(beforeRead);
    updateRunRegistry(config, (registry) => {
      registry.runs[0].orchestrator!.observation = {
        status: 'waiting',
        at: '2000-01-01T00:00:00Z',
        evidence: 'authorization pending',
      };
      registry.runs[0].orchestrator!.startupFailures = [
        { error: 'startup uncertain', resolvedAt: '2000-01-01T00:01:00Z' },
      ];
    });
    const waitingSnapshot = await readDashboardFleet({ id: 'fleet', config: config.file });
    expect(
      waitingSnapshot.tasks.find((t) => t.runId === first.id)?.executionEvidence,
    ).toMatchObject({
      acceptance: 'unknown',
      attempts: [
        { execution: 'waiting', stale: true, startupFailures: [{ error: 'startup uncertain' }] },
      ],
    });
    expect(inspectRuns(config).runs).toHaveLength(2);
    const request = {
      runId: first.id,
      authority: first.orchestratorId,
      subject: 'owner/repo#7',
      role: 'worker' as const,
      stage: 'implementation',
      inputRevision: 'head-a',
      brief: 'Implement task',
      prerequisites: [],
    };
    const stage = await dispatchStage(config, runner, request);
    let sends = 0;
    const interactiveRunner = {
      ...runner,
      interactive: true,
      async send() {
        sends++;
        return { status: 'uncertain' as const, evidence: 'connection lost after paste' };
      },
    };
    const message = { id: 'operator-followup', brief: 'Check ownership\nThen report' };
    await sendStageMessage(config, interactiveRunner, stage.id, first.orchestratorId, message);
    await sendStageMessage(config, interactiveRunner, stage.id, first.orchestratorId, message);
    expect(sends).toBe(1);
    expect(inspectRuns(config).dispatches![0].messages![0].status).toBe('uncertain');
    expect(inspectRuns(config).dispatches![0].lifecycle).toBe('running');
    expect((await dispatchStage(config, runner, request)).id).toBe(stage.id);
    await expect(
      dispatchStage(config, runner, {
        ...request,
        role: 'landing',
        stage: 'pr-merge',
        prerequisites: [],
      }),
    ).rejects.toThrow(/mandatory/);
    verifiedStopped = false;
    await expect(
      dispatchStage(config, runner, { ...request, stage: 'other-role' }),
    ).rejects.toThrow(/termination/);
    await expect(
      dispatchStage(config, runner, { ...request, inputRevision: 'new-input' }),
    ).rejects.toThrow(/termination/);
    verifiedStopped = true;

    await expect(
      retryStage(config, runner, stage.id, first.orchestratorId, async () => false),
    ).rejects.toThrow(/occupancy/);
    const retried = await retryStage(
      config,
      runner,
      stage.id,
      first.orchestratorId,
      async () => true,
    );
    expect(retried.attempts).toHaveLength(2);
    const dependent = {
      ...request,
      stage: 'merge',
      role: 'landing' as const,
      prerequisites: [stage.id],
    };
    await expect(dispatchStage(config, runner, dependent)).rejects.toThrow(/prerequisite/);
    const receipt = publishStageReceipt(config, {
      dispatchId: stage.id,
      attemptId: retried.attempts[1].id,
      runId: first.id,
      subject: request.subject,
      role: request.role,
      stage: request.stage,
      provider: 'codex',
      inputRevision: 'head-a',
      outcome: 'completed',
      evidence: [first.brief],
    });
    await expect(
      acceptStageReceipt(config, first.orchestratorId, receipt.id, async () => ({
        currentRevision: 'head-b',
        ownership: true,
        evidence: 'checked',
      })),
    ).rejects.toThrow(/stale/);
    const corrected = publishStageReceipt(config, { ...receipt, corrects: receipt.id });
    await acceptStageReceipt(config, first.orchestratorId, corrected.id, async () => ({
      currentRevision: 'head-a',
      ownership: true,
      evidence: 'checked current facts',
    }));
    const acceptedView = await readDashboardFleet({ id: 'fleet', config: config.file });
    expect(
      acceptedView.tasks.find((t) => t.id === `fleet:managed:${stage.id}`)?.executionEvidence,
    ).toMatchObject({
      acceptance: 'accepted',
      receipts: expect.arrayContaining([
        {
          id: corrected.id,
          attemptId: corrected.attemptId,
          outcome: corrected.outcome,
          accepted: true,
        },
      ]),
    });
    updateRunRegistry(config, (state) => {
      state.dispatches!.find((d) => d.id === stage.id)!.acceptedReceipt = 'missing-receipt';
    });
    const conflictingView = await readDashboardFleet({ id: 'fleet', config: config.file });
    expect(
      conflictingView.tasks.find((t) => t.id === `fleet:managed:${stage.id}`)?.executionEvidence
        ?.acceptance,
    ).toBe('conflicting');
    updateRunRegistry(config, (state) => {
      state.dispatches!.find((d) => d.id === stage.id)!.acceptedReceipt = corrected.id;
    });
    verifiedStopped = false;
    await expect(
      dispatchStage(config, runner, { ...request, prerequisites: [stage.id] }),
    ).rejects.toThrow(/termination/);
    verifiedStopped = true;
    expect((await dispatchStage(config, runner, dependent)).stage).toBe('merge');
    expect(inspectRuns(config).receipts).toHaveLength(2);
    // Crash after publication but before the registry/event update: recover immutable files.
    updateRunRegistry(config, (state) => {
      state.receipts = [];
      state.stageEvents = [];
    });
    const recovered = await recoverRun(config, runner, first.id);
    expect(recovered.pendingDispatches).toContain(stage.id);
    expect(inspectRuns(config).receipts).toHaveLength(2);
    await recoverRun(config, runner, first.id);
    expect(inspectRuns(config).stageEvents).toHaveLength(2);
    expect(launches).toBe(5);
    const mergeStage = inspectRuns(config).dispatches!.find((d) => d.stage === 'merge')!;
    setRemediationLimit(config, first.id, first.orchestratorId, mergeStage.id, 1);
    const failed = publishStageReceipt(config, {
      ...receipt,
      dispatchId: mergeStage.id,
      attemptId: mergeStage.attempts[0].id,
      role: 'landing',
      stage: 'merge',
      outcome: 'changes_needed',
    });
    await expect(
      acceptStageReceipt(config, first.orchestratorId, failed.id, async () => ({
        currentRevision: 'head-a',
        ownership: true,
        evidence: 'Checks still failing',
      })),
    ).rejects.toThrow(/Rejected/);
    await recoverRun(config, runner, first.id);
    await expect(
      retryStage(config, runner, mergeStage.id, first.orchestratorId, async () => true),
    ).rejects.toThrow(/exhausted/);
    const oldAuthority = first.orchestratorId;
    await recoverRun(config, runner, first.id, {
      stopped: async () => true,
      replaceOrchestrator: true,
    });
    await expect(
      dispatchStage(config, runner, { ...request, authority: oldAuthority, stage: 'stale' }),
    ).rejects.toThrow(/authority/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test.each(['agy', 'claude'])(
  'Run retains %s provider across dispatch and rejects conflicting adapter',
  async (provider) => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-provider-')));
    mkdirSync(join(project, 'pool'));
    const config = {
      file: join(project, '.epic-config.json'),
      project,
      root: join(project, 'pool'),
      slots: [],
      worktrees: true,
      base: 'main',
    };
    const runner = {
      name: provider,
      interactive: true,
      async stopped() {
        return true;
      },
      async preflight() {},
      async start() {
        return { conversation: 'ack', address: 'tmux:actual', evidence: 'provider ack' };
      },
    };
    try {
      const run = await startRun(
        config,
        runner,
        { repository: 'owner/repo', number: 1, kind: 'issue', title: 'task', body: 'task' },
        provider,
      );
      const stage = await dispatchStage(config, runner, {
        runId: run.id,
        authority: run.orchestratorId,
        subject: 'owner/repo#1',
        role: 'worker',
        stage: 'implementation',
        inputRevision: 'v1',
        brief: 'task',
        prerequisites: [],
      });
      expect(stage.attempts[0].runner).toBe(provider);
      await expect(
        startRun(config, { ...runner, name: 'codex' }, run.subject, 'codex'),
      ).rejects.toThrow(/conflict/);
      await expect(
        dispatchStage(
          config,
          { ...runner, name: 'codex' },
          { ...stage, runId: run.id, authority: run.orchestratorId },
        ),
      ).rejects.toThrow(/provider/);
      expect(inspectRuns(config).runs[0].provider).toBe(provider);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  },
);

test.each(['agy', 'claude'])(
  'managed %s adapter requires durable provider startup and success evidence',
  async (provider) => {
    const { managedRunner } = await import('../../packages/core/src/workflow/runtime.js');
    const directory = mkdtempSync(join(tmpdir(), 'pc-stream-'));
    const runner = managedRunner(provider);
    const attempt = {
      id: 'a',
      fleet: 'fleet',
      runner: provider,
      role: 'worker' as const,
      brief: 'task',
      status: 'starting' as const,
      created: 'now',
      directory,
      checkout: directory,
      address: 'tmux:actual',
    };
    try {
      writeFileSync(
        join(directory, 'events.jsonl'),
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-id' }) + '\n',
      );
      expect(await runner.recoverReceipt(attempt)).toBeUndefined();
      writeFileSync(
        join(directory, 'events.jsonl'),
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-id' }) +
          '\n' +
          JSON.stringify({ type: 'assistant', message: { content: [] } }) +
          '\n' +
          JSON.stringify({ type: 'result', subtype: 'success', result: 'delivered' }) +
          '\n',
      );
      expect((await runner.recoverReceipt(attempt))?.conversation).toBe('session-id');
      writeFileSync(join(directory, 'exit-code'), '0');
      expect(await runner.collect(attempt)).toBe('delivered');
      writeFileSync(
        join(directory, 'events.jsonl'),
        JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'failed' }),
      );
      await expect(runner.collect(attempt)).rejects.toThrow(/completed result/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test('overlapping child intake reconnects ownership and consuming EPIC references preserve provider', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-overlap-')));
  mkdirSync(join(project, 'pool'));
  const config = {
    file: join(project, '.epic-config.json'),
    project,
    root: join(project, 'pool'),
    slots: [],
    worktrees: true,
    base: 'main',
  };
  let launches = 0;
  const runner = {
    interactive: true,
    name: 'codex',
    async stopped() {
      return true;
    },
    async preflight() {},
    async start() {
      launches++;
      return { conversation: 'session', address: 'tmux:verified', evidence: 'ack' };
    },
  };
  const subject = {
    repository: 'owner/repo',
    number: 20,
    kind: 'epic' as const,
    title: 'parent',
    body: 'goal',
  };
  try {
    const epic = await startRun(config, runner, subject, 'codex');
    referenceRunSubject(config, epic.id, 'owner/repo#21');
    const child = { ...subject, number: 21, kind: 'issue' as const, parent: 20, blockedBy: [] };
    expect((await startRun(config, runner, child, 'codex')).id).toBe(epic.id);
    await expect(startRun(config, { ...runner, name: 'claude' }, child, 'claude')).rejects.toThrow(
      /provider conflict/,
    );
    expect(launches).toBe(1);
    const standalone = await startRun(config, runner, { ...child, number: 22 }, 'codex');
    expect(referenceRunSubject(config, epic.id, 'owner/repo#22')).toBe(standalone.id);
    expect(inspectRuns(config).subjects?.find((s) => s.subject === 'owner/repo#22')).toMatchObject({
      ownerRunId: standalone.id,
      consumingRunIds: [epic.id],
    });
    expect(launches).toBe(2);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test.each(['direct', 'validated', 'collect', 'followup', 'followup-complete'])(
  'persistent acceptance (%s) stops only after outstanding assignments complete',
  async (path) => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-interactive-')));
    mkdirSync(join(project, 'pool'));
    const config = {
      file: join(project, '.epic-config.json'),
      project,
      root: join(project, 'pool'),
      slots: [],
      worktrees: true,
      base: 'main',
    };
    let live = true;
    let stops = 0;
    let allowStop = false;
    const runner = {
      name: 'codex',
      interactive: true,
      cancellation: true,
      async preflight() {},
      async start() {
        return {
          conversation: 'exact-conversation',
          address: 'tmux:known',
          evidence: 'brief acknowledged',
        };
      },
      async send() {
        return { status: 'delivered' as const, evidence: 'queued followup' };
      },
      async result() {
        return 'durable correlated result';
      },
      async collect() {
        throw new Error('must not wait for exit');
      },
      async stopped() {
        return !live;
      },
      async cancel() {
        stops++;
        if (allowStop) live = false;
        return { evidence: 'verified exit' };
      },
      async observe() {
        return {
          status: 'waiting' as const,
          at: '2026-11-01T00:00:00Z',
          evidence: 'question pending',
        };
      },
    };
    try {
      writeFileSync(config.file, JSON.stringify({ clone_root: 'pool', local_worktrees: true }));
      const run = await startRun(
        config,
        runner,
        {
          repository: 'owner/repo',
          number: 99,
          kind: 'issue',
          title: 'controlled lifecycle',
          body: 'complete',
        },
        'codex',
      );
      const dispatch = await dispatchStage(config, runner, {
        runId: run.id,
        authority: run.orchestratorId,
        subject: 'owner/repo#99',
        role: 'worker',
        stage: 'implementation',
        inputRevision: 'head',
        brief: 'Complete one task',
        prerequisites: [],
      });
      await recoverRun(config, runner, run.id);
      expect(inspectRuns(config).dispatches![0].lifecycle).toBe('running');
      expect(inspectRuns(config).dispatches![0].attempts[0].observation?.status).toBe('waiting');
      await expect(
        releaseAcceptedExecution(config, runner, dispatch.id, run.orchestratorId),
      ).rejects.toThrow(/Acceptance/);
      expect(stops).toBe(0);
      if (path === 'followup') {
        await sendStageMessage(config, runner, dispatch.id, run.orchestratorId, {
          id: 'next-assignment',
          brief: 'Do additional work',
        });
      }
      const verify = async () => ({
        currentRevision: 'head',
        ownership: true,
        evidence: 'verified durable work',
      });
      if (path === 'collect') {
        await expect(
          collectBusinessTurn(config, runner, dispatch.attempts[0], () => {}),
        ).rejects.toThrow(/Unknown termination/);
      } else {
        expect(await collectBusinessTurn(config, runner, dispatch.attempts[0])).toBe(
          'durable correlated result',
        );
      }
      let receipt = inspectRuns(config).receipts!.at(-1)!;
      if (path === 'followup-complete')
        receipt = publishStageReceipt(config, {
          ...receipt,
          corrects: receipt.id,
          messageIds: ['next-assignment'],
        });
      if (path === 'followup') {
        await acceptStageReceipt(config, run.orchestratorId, receipt.id, verify, runner);
        expect(live).toBe(true);
        expect(stops).toBe(0);
        expect(inspectRuns(config).resources).toHaveLength(1);
        receipt = publishStageReceipt(config, {
          ...receipt,
          corrects: receipt.id,
          messageIds: ['next-assignment'],
        });
      }
      if (path === 'direct' || path.startsWith('followup'))
        await expect(
          acceptStageReceipt(config, run.orchestratorId, receipt.id, verify, runner),
        ).rejects.toThrow(/Unknown termination/);
      if (path === 'validated')
        await expect(
          acceptValidatedBusinessTurns(config, [dispatch.attempts[0]], 'checked', runner),
        ).rejects.toThrow(/Unknown termination/);
      expect(live).toBe(true);
      expect(inspectRuns(config).resources).toHaveLength(1);
      allowStop = true;
      await acceptStageReceipt(config, run.orchestratorId, receipt.id, verify, runner);
      expect(stops).toBe(2);

      expect(inspectRuns(config).resources).toHaveLength(1);
      expect(inspectRuns(config).dispatches![0].attempts[0].conversation).toBe(
        'exact-conversation',
      );
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  },
);
