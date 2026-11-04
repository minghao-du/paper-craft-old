import { describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { FleetConfig } from '../../packages/core/src/workflow/fleet/fleet-config.js';
import type { ManagedAttempt, RunnerAdapter } from '../../packages/core/src/workflow/runtime/runtime.js';
import {
  acceptStageReceipt,
  collectBusinessTurn,
  dispatchStage,
  inspectRuns,
  reconcileStageMessage,
  sendStageMessage,
  startRun,
  type StageFacts,
} from '../../packages/core/src/workflow/run/run-driver.js';
import { reconcileStartup } from '../../packages/core/src/workflow/run/startup.js';
import { initializeRole } from './initialize-role.js';

function createAttributedFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-attributed-')));
  const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  const configFile = join(project, '.epic-config.json');
  const config: FleetConfig = {
    file: configFile,
    project,
    root,
    slots: [],
    worktrees: true,
    base: 'main',
  };

  const receivedInputs: { id: string; brief: string }[] = [];
  const registeredReceipts = new Map<string, string>();
  let agentOutput: string | undefined = undefined;
  let isStopped = false;
  let sendShouldBeUncertain = false;

  const runner: RunnerAdapter = {
    name: 'agy',
    interactive: true,
    automaticStartup: true,
    cancellation: true,
    async preflight() {},
    async start(attempt: ManagedAttempt) {
      attempt.terminalSession = `pc-run-${attempt.run}`;
      attempt.address = `tmux:%${attempt.id.slice(0, 4)}`;
      initializeRole(attempt);
      return {
        conversation: `conv-${attempt.id}`,
        address: attempt.address,
        evidence: `Started ${attempt.role} ${attempt.id}`,
      };
    },
    async send(_attempt: ManagedAttempt, message: { id: string; brief: string }) {
      receivedInputs.push(message);
      if (sendShouldBeUncertain) {
        return {
          status: 'uncertain' as const,
          evidence: 'network timeout during paste',
        };
      }
      registeredReceipts.set(message.id, `Native exact agy receipt for ${message.id}`);
      return {
        status: 'delivered' as const,
        evidence: `Native exact agy USER_INPUT step for ${message.id}`,
      };
    },
    async messageReceipt(_attempt: ManagedAttempt, message: { id: string; brief: string }) {
      return registeredReceipts.get(message.id);
    },
    async result(_attempt: ManagedAttempt, _dispatchId: string) {
      return agentOutput;
    },
    async collect(attempt: ManagedAttempt, options?: { timeoutMs?: number; dispatchId?: string }) {
      const id = options?.dispatchId ?? attempt.dispatchId ?? attempt.id;
      const deadline = options?.timeoutMs !== undefined ? Date.now() + options.timeoutMs : undefined;
      for (;;) {
        const out = await runner.result!(attempt, id);
        if (out !== undefined) return out;
        if (await runner.stopped!(attempt)) {
          throw new Error('agy exited without a correlated task result (Runner stopped without a correlated task result)');
        }
        if (deadline !== undefined && Date.now() >= deadline) {
          throw new Error('Timed out waiting for correlated task result');
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    async stopped(_attempt: ManagedAttempt) {
      return isStopped;
    },
    async cancel(_attempt: ManagedAttempt) {
      isStopped = true;
      return { evidence: 'Pane terminated' };
    },
  };

  return {
    root,
    config,
    runner,
    receivedInputs,
    registeredReceipts,
    setAgentOutput(out: string | undefined) {
      agentOutput = out;
    },
    setIsStopped(stopped: boolean) {
      isStopped = stopped;
    },
    setSendShouldBeUncertain(uncertain: boolean) {
      sendShouldBeUncertain = uncertain;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('Attributed messaging and result collection through Runtime contract', () => {
  test('Complete public behavioral path: dispatch, message delivery, result collection, and Receipt acceptance for activated Worker', async () => {
    const f = createAttributedFixture();
    try {
      // 1. Start Run and Orchestrator
      const run = await startRun(
        f.config,
        f.runner,
        { repository: 'owner/repo', number: 123, kind: 'issue', title: 'test', body: 'test' },
        'agy',
      );
      const orchestrator = inspectRuns(f.config).runs.find((r) => r.id === run.id)!.orchestrator!;
      expect(orchestrator.status).toBe('running');

      // 2. Dispatch Worker stage
      const workerDispatch = await dispatchStage(f.config, f.runner, {
        runId: run.id,
        authority: run.orchestratorId,
        subject: 'owner/repo#123',
        role: 'worker',
        stage: 'implementation',
        brief: 'Implement ticket feature according to spec',
        inputRevision: 'rev-init',
        prerequisites: [],
      });
      expect(workerDispatch.lifecycle).toBe('running');
      const workerAttempt = workerDispatch.attempts[0];
      expect(workerAttempt.startupGate).toBe(true);

      // Business execution before activation delivery MUST be rejected
      await expect(
        collectBusinessTurn(f.config, f.runner, workerAttempt),
      ).rejects.toThrow(/Attempt startup incomplete/);

      // 3. Activate Worker
      await reconcileStartup(f.config, f.runner, run.id);
      const activatedWorker = inspectRuns(f.config).dispatches![0].attempts[0];
      expect(activatedWorker.activation?.status).toBe('delivered');

      // 4. Deliver attributed message to activated Worker with uncertain delivery reconciliation
      const message1 = { id: 'msg-spec-guidance', brief: 'Ensure error paths are tested' };
      f.setSendShouldBeUncertain(true);
      await sendStageMessage(f.config, f.runner, workerDispatch.id, run.orchestratorId, message1);

      let currentDispatch = inspectRuns(f.config).dispatches![0];
      expect(currentDispatch.messages).toHaveLength(1);
      expect(currentDispatch.messages![0].status).toBe('uncertain');

      // Reconciling uncertain message: adapter discovers receipt -> upgraded without replay
      f.setSendShouldBeUncertain(false);
      f.registeredReceipts.set(message1.id, 'Discovered exact transcript USER_INPUT step');
      const reconciled = await reconcileStageMessage(
        f.config,
        f.runner,
        workerDispatch.id,
        run.orchestratorId,
        message1.id,
      );
      expect(reconciled.status).toBe('delivered');

      currentDispatch = inspectRuns(f.config).dispatches![0];
      expect(currentDispatch.messages![0].status).toBe('delivered');
      expect(f.receivedInputs).toHaveLength(3); // 1 orchestrator activation + 1 worker activation + 1 message

      // Calling sendStageMessage again when already delivered does NOT send again
      await sendStageMessage(f.config, f.runner, workerDispatch.id, run.orchestratorId, message1);
      expect(f.receivedInputs).toHaveLength(3); // Still 3, no duplicate send!

      // 5. Result collection through Runtime contract
      const expectedTaskResult = JSON.stringify({
        status: 'success',
        summary: 'Feature implemented cleanly',
      });
      f.setAgentOutput(expectedTaskResult);

      // Merely obtaining a result cannot accept a Receipt
      const collectedResult = await collectBusinessTurn(
        f.config,
        f.runner,
        activatedWorker,
        undefined, // validate is undefined: domain acceptance is deferred to Workflow
        { timeoutMs: 500, messageIds: [message1.id] },
      );
      expect(collectedResult).toBe(expectedTaskResult);

      // Receipt is published in registry, but lifecycle is 'reported', NOT 'accepted'!
      const reportedDispatch = inspectRuns(f.config).dispatches![0];
      expect(reportedDispatch.lifecycle).toBe('reported');
      const publishedReceipt = inspectRuns(f.config).receipts?.find(
        (r) => r.dispatchId === workerDispatch.id,
      );
      expect(publishedReceipt).toBeDefined();
      expect(publishedReceipt!.outcome).toBe('completed');
      expect(publishedReceipt!.messageIds).toContain(message1.id);

      // Messages remain delivered, not yet completed until receipt acceptance
      expect(reportedDispatch.messages![0].status).toBe('delivered');

      // 6. Workflow Receipt validation and explicit acceptance
      const verifyFacts = async (): Promise<StageFacts> => ({
        currentRevision: 'rev-init',
        ownership: true,
        evidence: 'Verified implementation meets spec',
      });

      await acceptStageReceipt(
        f.config,
        run.orchestratorId,
        publishedReceipt!.id,
        verifyFacts,
        f.runner,
      );

      // Post-acceptance verification
      const acceptedDispatch = inspectRuns(f.config).dispatches![0];
      expect(acceptedDispatch.lifecycle).toBe('accepted');
      expect(acceptedDispatch.acceptedReceipt).toBe(publishedReceipt!.id);

      // Associated messages transition to completed upon receipt acceptance
      expect(acceptedDispatch.messages![0].status).toBe('completed');
    } finally {
      f.cleanup();
    }
  });

  test('Waiting for result handles unavailable output, stopped runner, and deadlines explicitly without inventing output', async () => {
    const f = createAttributedFixture();
    try {
      const run = await startRun(
        f.config,
        f.runner,
        { repository: 'owner/repo', number: 456, kind: 'issue', title: 'test', body: 'test' },
        'agy',
      );
      const workerDispatch = await dispatchStage(f.config, f.runner, {
        runId: run.id,
        authority: run.orchestratorId,
        subject: 'owner/repo#456',
        role: 'worker',
        stage: 'implementation',
        brief: 'Worker task for result handling test',
        inputRevision: 'rev-456',
        prerequisites: [],
      });
      await reconcileStartup(f.config, f.runner, run.id);
      const activatedWorker = inspectRuns(f.config).dispatches![0].attempts[0];

      // A) Output unavailable and deadline exceeded -> explicit timeout error
      f.setAgentOutput(undefined);
      await expect(
        collectBusinessTurn(f.config, f.runner, activatedWorker, undefined, { timeoutMs: 50 }),
      ).rejects.toThrow(/Timed out waiting for correlated task result/);

      // B) Output unavailable and runner stops -> explicit stopped runner error
      f.setIsStopped(true);
      await expect(
        collectBusinessTurn(f.config, f.runner, activatedWorker, undefined, { timeoutMs: 1000 }),
      ).rejects.toThrow(/Runner stopped without a correlated task result/);

      // C) Output becomes available before deadline -> successfully collected without inventing output
      f.setIsStopped(false);
      setTimeout(() => {
        f.setAgentOutput('Correlated turn outcome');
      }, 50);

      const result = await collectBusinessTurn(
        f.config,
        f.runner,
        activatedWorker,
        undefined,
        { timeoutMs: 2000 },
      );
      expect(result).toBe('Correlated turn outcome');
    } finally {
      f.cleanup();
    }
  });

  test('Uncertain message delivery is safely retried only after reconciling non-receipt', async () => {
    const f = createAttributedFixture();
    try {
      const run = await startRun(
        f.config,
        f.runner,
        { repository: 'owner/repo', number: 789, kind: 'issue', title: 'test', body: 'test' },
        'agy',
      );
      const workerDispatch = await dispatchStage(f.config, f.runner, {
        runId: run.id,
        authority: run.orchestratorId,
        subject: 'owner/repo#789',
        role: 'worker',
        stage: 'implementation',
        brief: 'Worker for retry test',
        inputRevision: 'rev-789',
        prerequisites: [],
      });
      await reconcileStartup(f.config, f.runner, run.id);

      const message = { id: 'retryable-msg', brief: 'Execute retry step' };

      // Step 1: Send with network failure -> uncertain delivery
      f.setSendShouldBeUncertain(true);
      await sendStageMessage(f.config, f.runner, workerDispatch.id, run.orchestratorId, message);
      expect(inspectRuns(f.config).dispatches![0].messages![0].status).toBe('uncertain');
      const sendCountAfterFailure = f.receivedInputs.length;

      // Step 2: Try to send again while still uncertain and messageReceipt returns undefined (not delivered)
      // Uncertain delivery is reconciled as not received, so it retries sending!
      f.setSendShouldBeUncertain(false);
      // messageReceipt returns undefined -> reconciled as not delivered -> retries send
      await sendStageMessage(f.config, f.runner, workerDispatch.id, run.orchestratorId, message);

      expect(f.receivedInputs.length).toBe(sendCountAfterFailure + 1);
      expect(inspectRuns(f.config).dispatches![0].messages![0].status).toBe('delivered');
    } finally {
      f.cleanup();
    }
  });

  test('Receipt validation rejection prevents acceptance and updates remediation', async () => {
    const f = createAttributedFixture();
    try {
      const run = await startRun(
        f.config,
        f.runner,
        { repository: 'owner/repo', number: 999, kind: 'issue', title: 'test', body: 'test' },
        'agy',
      );
      const workerDispatch = await dispatchStage(f.config, f.runner, {
        runId: run.id,
        authority: run.orchestratorId,
        subject: 'owner/repo#999',
        role: 'worker',
        stage: 'implementation',
        brief: 'Worker for rejection test',
        inputRevision: 'rev-valid',
        prerequisites: [],
      });
      await reconcileStartup(f.config, f.runner, run.id);
      const activatedWorker = inspectRuns(f.config).dispatches![0].attempts[0];

      f.setAgentOutput('task result');
      await collectBusinessTurn(f.config, f.runner, activatedWorker);

      const publishedReceipt = inspectRuns(f.config).receipts!.find(
        (r) => r.dispatchId === workerDispatch.id,
      )!;

      // Verification fails due to revision mismatch
      const invalidFacts = async (): Promise<StageFacts> => ({
        currentRevision: 'rev-stale-mismatch',
        ownership: true,
        evidence: 'Invalid revision',
      });

      await expect(
        acceptStageReceipt(f.config, run.orchestratorId, publishedReceipt.id, invalidFacts, f.runner),
      ).rejects.toThrow(/Rejected stale, unsupported or unauthorized Receipt/);

      const rejectedDispatch = inspectRuns(f.config).dispatches![0];
      expect(rejectedDispatch.lifecycle).toBe('rejected');
      expect(rejectedDispatch.remediation?.consecutive).toBe(1);
    } finally {
      f.cleanup();
    }
  });
});
