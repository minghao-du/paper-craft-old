import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  inspectRuns,
  updateRunRegistry,
} from '../../packages/core/src/workflow/run/run-registry.js';
import {
  startRun,
} from '../../packages/core/src/workflow/run/startup.js';
import {
  dispatchStage,
  publishStageReceipt,
  acceptStageReceipt,
  retryStage,
  setRemediationLimit,
  startBusinessTurn,
  collectBusinessTurn,
  validateImplementationResult,
  acceptValidatedBusinessTurns,
  sendStageMessage,
  reconcileStageMessage,
  stopAcceptedExecution,
  releaseAcceptedExecution,
} from '../../packages/core/src/workflow/run/stage-execution.js';

function createFixture() {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-stage-exec-')));
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
  return { project, config };
}

test('stage-execution operations function directly through stage-execution module without loading run-driver', async () => {
  const { project, config } = createFixture();
  let stoppedState = false;
  let terminatedState = false;
  let sentMessageEvidence: string | undefined;

  const runner = {
    interactive: true,
    name: 'codex',
    async preflight() {},
    async start() {
      return { conversation: 'conv-stage-test', address: 'tmux:test', evidence: 'start-ack' };
    },
    async collect() {
      return JSON.stringify({
        status: 'completed',
        repository: 'owner/repo',
        issue: 201,
        evidence: 'validated code changes',
      });
    },
    async stopped() {
      return stoppedState;
    },
    async terminate() {
      terminatedState = true;
      stoppedState = true;
      return { status: 'terminated' as const, evidence: 'terminated-ack' };
    },
    async send(_attempt: unknown, message: { id: string; brief: string }) {
      sentMessageEvidence = 'delivered:' + message.id;
      return { status: 'delivered' as const, evidence: sentMessageEvidence };
    },
    async messageReceipt(_attempt: unknown, message: { id: string }) {
      return 'receipt:' + message.id;
    },
  };

  try {
    // 1. Start a run via startup.js directly
    const run = await startRun(
      config,
      runner,
      { repository: 'owner/repo', number: 201, kind: 'issue', title: 'Issue 201', body: 'Body 201' },
      'codex',
    );

    // 2. Dispatch stage
    const dispatch = await dispatchStage(config, runner, {
      runId: run.id,
      authority: run.orchestratorId,
      subject: 'owner/repo#201',
      role: 'worker',
      stage: 'implementation',
      inputRevision: 'rev-0',
      brief: 'implement feature',
      prerequisites: [],
    });
    expect(dispatch.lifecycle).toBe('running');
    expect(dispatch.attempts.length).toBe(1);

    // 3. Send stage message
    await sendStageMessage(config, runner, dispatch.id, run.orchestratorId, {
      id: 'msg-1',
      brief: 'clarification note',
    });
    const reconciled = await reconcileStageMessage(
      config,
      runner,
      dispatch.id,
      run.orchestratorId,
      'msg-1',
    );
    expect(reconciled.status).toBe('delivered');

    // 4. Collect business turn with validation
    const turnResult = await collectBusinessTurn(
      config,
      runner,
      dispatch.attempts[0],
      (result) => validateImplementationResult(result, 'owner/repo', 201),
      { messageIds: ['msg-1'] },
    );
    expect(turnResult).toContain('validated code changes');

    // 5. Verify dispatch lifecycle transitioned to accepted
    const registryAfterCollect = inspectRuns(config);
    const updatedDispatch = registryAfterCollect.dispatches?.find((d) => d.id === dispatch.id);
    expect(updatedDispatch?.lifecycle).toBe('accepted');
    expect(updatedDispatch?.acceptedReceipt).toBeDefined();

    // 6. Stop and release accepted execution
    await stopAcceptedExecution(config, runner, dispatch.id, run.orchestratorId);
    expect(terminatedState).toBe(true);

    let cleanedUp = false;
    await releaseAcceptedExecution(
      config,
      runner,
      dispatch.id,
      run.orchestratorId,
      () => {
        cleanedUp = true;
      },
    );
    expect(cleanedUp).toBe(true);

    // 7. Verify remediation limit helper
    setRemediationLimit(config, run.id, run.orchestratorId, dispatch.id, 5);
    const registryAfterRemediation = inspectRuns(config);
    const remDispatch = registryAfterRemediation.dispatches?.find((d) => d.id === dispatch.id);
    expect(remDispatch?.remediation?.limit).toBe(5);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
