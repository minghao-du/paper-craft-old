/** Stage execution workflow: dispatch, retry, result submission/acceptance, turns, messaging and release. */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { workflowSource, type FleetConfig } from '../fleet/fleet-config.js';
import {
  requireInteractive,
  terminateAttempt,
  type ManagedAttempt,
  type RunnerAdapter,
} from '../runtime/runtime.js';
import { assertStageRole } from '../runtime/workflow-role.js';
import { ensureStartupRecovery } from '../runtime/startup-supervisor.js';
import { pipelineAccepted } from '../delivery/epic-finalization.js';
import { verifyRoleInitialization } from './role-initialization.js';
import {
  authorize,
  findDispatch,
  home,
  inspectRuns,
  updateRunRegistry,
  type RunRegistry,
  type StageRequest,
  type StageDispatch,
  type StageReceipt,
  type StageFacts,
} from './run-registry.js';
import { assignmentWithRequirements } from './startup.js';
import {
  reserveSubject,
  releaseRunCheckout,
  orchestratorForSubject,
  reserveRunCheckout,
} from './run-ownership.js';

export type {
  StageRequest,
  StageDispatch,
  StageReceipt,
  StageFacts,
} from './run-registry.js';

/** Options for stage dispatch requests. */
export type StageDispatchOptions = StageRequest;

/** Options for publishing a stage receipt. */
export type StageReceiptOptions = Omit<StageReceipt, 'id'>;

/** Verification callback for accepting a stage receipt. */
export type StageAcceptanceVerifier = (
  dispatch: StageDispatch,
  receipt: StageReceipt,
) => Promise<StageFacts>;

/** Verification callback to validate facts before accepting a stage receipt. */
export type StageFactVerifier = StageAcceptanceVerifier;

/** Options for retrying a stage attempt. */
export interface StageRetryOptions {
  /** Whether to replace the underlying conversation rather than reusing the prior conversation. */
  replaceConversation?: boolean;
}

/** Options for collecting a business turn from an attempt. */
export interface CollectBusinessTurnOptions {
  /** Maximum wait duration in milliseconds before timing out. */
  timeoutMs?: number;
  /** Correlated message IDs addressed in this business turn. */
  messageIds?: string[];
}

/** Result payload of a completed business turn. */
export type BusinessTurnResult = string;

/** Message sent to an interactive stage attempt. */
export interface StageMessageInput {
  /** Unique message identifier. */
  id: string;
  /** Detailed instruction or prompt for the attempt. */
  brief: string;
}

/** Result of reconciling a stage message delivery. */
export interface ReconcileStageMessageResult {
  /** Delivery status. */
  status: 'delivered' | 'uncertain';
  /** Correlated delivery evidence if available. */
  evidence?: string;
}


function resolveGateAuthFile(roundRoot: string, subject?: string): string {
  const defaultFile = join(roundRoot, 'gate-authorization.json');
  if (existsSync(defaultFile)) {
    if (!subject) return defaultFile;
    try {
      const defaultAuth = JSON.parse(readFileSync(defaultFile, 'utf8'));
      if (subject.endsWith('#' + defaultAuth.issue)) return defaultFile;
      for (const specific of ['gate-worker1-authorization.json', 'gate-worker2-authorization.json']) {
        const specPath = join(roundRoot, specific);
        if (existsSync(specPath)) {
          try {
            const specAuth = JSON.parse(readFileSync(specPath, 'utf8'));
            if (subject.endsWith('#' + specAuth.issue)) return specPath;
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
    return defaultFile;
  }
  for (const specific of ['gate-worker1-authorization.json', 'gate-worker2-authorization.json']) {
    const specPath = join(roundRoot, specific);
    if (existsSync(specPath)) return specPath;
  }
  return defaultFile;
}

/** Find all child subjects (both referenced external subjects and owned child subjects) for a Run. */
export function epicChildSubjects(registry: RunRegistry, runId: string): string[] {
  const epicRun = registry.runs.find((r) => r.id === runId);
  const epicSubject = epicRun ? `${epicRun.subject.repository}#${epicRun.subject.number}` : undefined;
  const referenced =
    registry.subjects?.filter((s) => s.consumingRunIds?.includes(runId)).map((s) => s.subject) ?? [];
  const owned =
    registry.subjects?.filter((s) => s.ownerRunId === runId && s.subject !== epicSubject).map((s) => s.subject) ?? [];
  const fromDispatches =
    registry.dispatches?.filter((d) => d.runId === runId && d.subject !== epicSubject).map((d) => d.subject) ?? [];
  return [...new Set([...referenced, ...owned, ...fromDispatches])];
}

/** Verify that all required child deliveries for an EPIC run are completed in registry.deliveries. */
export function verifyEpicDeliveries(registry: RunRegistry, runId: string): void {
  const children = epicChildSubjects(registry, runId);
  for (const child of children) {
    const [repo, numStr] = child.split('#');
    const num = Number(numStr);
    const d = registry.deliveries?.find((del) => del.repository === repo && del.issue === num);
    if (!d || d.status !== 'done' || !d.recorded || !d.released || !d.archive) {
      throw new Error(`Incomplete delivery for required child ${child}`);
    }
  }
}

/** Reserve before launch; replay returns the same generation and never launches twice. */
export async function dispatchStage(
  config: FleetConfig,
  runner: RunnerAdapter,
  request: StageRequest,
): Promise<StageDispatch> {
  requireInteractive(runner);
  await runner.preflight();
  const snapshot = inspectRuns(config);
  const owningRun = authorize(snapshot, request.runId, request.authority);
  if (owningRun.constraints?.kind === 'demo') {
    const roundRoot = dirname(config.project);
    const controlFile = join(roundRoot, 'control.json');
    if (existsSync(controlFile)) {
      const control = JSON.parse(readFileSync(controlFile, 'utf8'));
      if (control.stopped || control.releasing || control.activeMs >= control.budgetMs) {
        throw new Error(
          `Demo round ${owningRun.constraints.roundId} is stopped or expired; cannot dispatch stage`,
        );
      }
    }
    if (request.role === 'pipeline-audit' || request.role === 'research-state') {
      if (!owningRun.epicClosure || owningRun.epicClosure.status !== 'closed') {
        throw new Error('Verified actual Parent closure required before specialist dispatch');
      }
      if (owningRun.provider !== 'agy') {
        throw new Error('Agy specialist dispatch required');
      }
    }
    if (request.role === 'worker') {
      const authFile = resolveGateAuthFile(roundRoot, request.subject);
      if (!existsSync(authFile)) {
        throw new Error(
          `Worker dispatch denied: matching Gate authorization required for demo round ${owningRun.constraints.roundId}`,
        );
      }
      const auth = JSON.parse(readFileSync(authFile, 'utf8'));
      if (auth.roundId !== owningRun.constraints.roundId) {
        throw new Error(
          `Worker dispatch denied: Gate authorization round mismatch: expected ${owningRun.constraints.roundId}, received ${auth.roundId}`,
        );
      }
      if (auth.runId !== owningRun.id) {
        throw new Error(
          `Worker dispatch denied: Gate authorization Run mismatch: expected ${owningRun.id}, received ${auth.runId}`,
        );
      }
      if (request.stage === 'final-records') {
        if (!request.subject.endsWith('#' + auth.issue)) {
          throw new Error(
            `Worker continuation denied: Gate authorization is for issue #${auth.issue}, cannot launch ${request.subject}`,
          );
        }
      } else {
        if (!request.subject.endsWith('#' + auth.issue)) {
          throw new Error(
            `Worker dispatch denied: Gate authorization is for issue #${auth.issue}, cannot launch ${request.subject}`,
          );
        }
        if (auth.claimed) {
          throw new Error('Worker dispatch denied: Gate authorization already claimed');
        }
        if (auth.inputRevision && auth.inputRevision !== request.inputRevision) {
          throw new Error(
            `Worker dispatch denied: input revision ${request.inputRevision} does not match authorized revision ${auth.inputRevision}`,
          );
        }
        if (auth.stage && auth.stage !== request.stage) {
          throw new Error(
            `Worker dispatch denied: authorized for stage ${auth.stage}, cannot launch ${request.stage}`,
          );
        }
        if (auth.briefHash) {
          const rawHash = createHash('sha256').update(request.brief).digest('hex');
          if (rawHash !== auth.briefHash) {
            throw new Error('Worker dispatch denied: brief does not match authorized brief');
          }
        }
        if (auth.requiredAncestorSha) {
          const targetRev = request.inputRevision;
          const checkoutDir = request.checkout ? workflowSource(config, request.checkout) : config.project;
          const gitCwd = existsSync(checkoutDir) ? checkoutDir : config.project;
          try {
            execFileSync('git', ['merge-base', '--is-ancestor', auth.requiredAncestorSha, targetRev], {
              cwd: gitCwd,
              encoding: 'utf8',
              stdio: 'pipe',
            });
          } catch {
            throw new Error(
              `Worker dispatch denied: task 2 revision ${targetRev} does not contain Task 1 merge ${auth.requiredAncestorSha} as an ancestor`,
            );
          }
        }
      }
    }
  }
  if (!request.brief.trim()) throw new Error('Incomplete stage inputs');
  request = { ...request, brief: assignmentWithRequirements(owningRun, request.brief) };
  const checkout = workflowSource(config, request.checkout ?? config.project);
  const occupying =
    snapshot.dispatches?.filter(
      (d) => d.runId === request.runId && d.attempts.some((a) => a.checkout === checkout),
    ) ?? [];
  for (const prior of occupying) {
    if (
      prior.subject === request.subject &&
      prior.role === request.role &&
      prior.stage === request.stage &&
      prior.inputRevision === request.inputRevision &&
      prior.brief === request.brief &&
      JSON.stringify(prior.prerequisites) === JSON.stringify(request.prerequisites)
    )
      continue;
    const attempt = prior.attempts.at(-1)!;
    if (!(await runner.stopped?.(attempt)))
      throw new Error(
        'Prior execution termination unverified; prerequisite occupancy remains reserved',
      );
  }
  let launch = false;
  const dispatch = updateRunRegistry(config, (registry) => {
    if (registry.revision !== snapshot.revision)
      throw new Error('Execution ownership changed during termination verification; retry');
    const run = authorize(registry, request.runId, request.authority);
    if (run.constraints?.kind === 'demo') {
      const roundRoot = dirname(config.project);
      const controlFile = join(roundRoot, 'control.json');
      if (existsSync(controlFile)) {
        const control = JSON.parse(readFileSync(controlFile, 'utf8'));
        if (control.stopped || control.releasing || control.activeMs >= control.budgetMs) {
          throw new Error(
            `Demo round ${run.constraints.roundId} is stopped or expired; cannot dispatch stage`,
          );
        }
      }
      if (request.role === 'worker') {
        const authFile = resolveGateAuthFile(roundRoot, request.subject);
        if (!existsSync(authFile)) {
          throw new Error(
            `Worker dispatch denied: matching Gate authorization required for demo round ${run.constraints.roundId}`,
          );
        }
        const auth = JSON.parse(readFileSync(authFile, 'utf8'));
        if (auth.roundId !== run.constraints.roundId) {
          throw new Error(
            `Worker dispatch denied: Gate authorization round mismatch: expected ${run.constraints.roundId}, received ${auth.roundId}`,
          );
        }
        if (auth.runId !== run.id) {
          throw new Error(
            `Worker dispatch denied: Gate authorization Run mismatch: expected ${run.id}, received ${auth.runId}`,
          );
        }
        if (request.stage === 'final-records') {
          if (!request.subject.endsWith('#' + auth.issue)) {
            throw new Error(
              `Worker continuation denied: Gate authorization is for issue #${auth.issue}, cannot launch ${request.subject}`,
            );
          }
        } else {
          if (!request.subject.endsWith('#' + auth.issue)) {
            throw new Error(
              `Worker dispatch denied: Gate authorization is for issue #${auth.issue}, cannot launch ${request.subject}`,
            );
          }
          if (auth.claimed) {
            throw new Error('Worker dispatch denied: Gate authorization already claimed');
          }
          if (auth.inputRevision && auth.inputRevision !== request.inputRevision) {
            throw new Error(
              `Worker dispatch denied: input revision ${request.inputRevision} does not match authorized revision ${auth.inputRevision}`,
            );
          }
          if (auth.stage && auth.stage !== request.stage) {
            throw new Error(
              `Worker dispatch denied: authorized for stage ${auth.stage}, cannot launch ${request.stage}`,
            );
          }
          if (auth.requiredAncestorSha) {
            const targetRev = request.inputRevision;
            const checkoutDir = request.checkout ? workflowSource(config, request.checkout) : config.project;
            const gitCwd = existsSync(checkoutDir) ? checkoutDir : config.project;
            try {
              execFileSync('git', ['merge-base', '--is-ancestor', auth.requiredAncestorSha, targetRev], {
                cwd: gitCwd,
                encoding: 'utf8',
                stdio: 'pipe',
              });
            } catch {
              throw new Error(
                `Worker dispatch denied: task 2 revision ${targetRev} does not contain Task 1 merge ${auth.requiredAncestorSha} as an ancestor`,
              );
            }
          }
        }
      }
    }
    if (runner.name !== run.provider)
      throw new Error(
        `Run provider mismatch: expected provider ${run.provider}, but received ${runner.name}`,
      );
    assertStageRole(request.stage, request.role, `Run ${request.runId}`);
    if (!request.brief.trim() || !request.inputRevision || !request.stage || !request.subject)
      throw new Error('Incomplete stage inputs');
    registry.dispatches ??= [];
    const previous = registry.dispatches.filter(
      (d) =>
        d.runId === run.id &&
        d.subject === request.subject &&
        d.role === request.role &&
        d.stage === request.stage,
    );
    const latest = previous.at(-1);
    if (
      latest &&
      latest.inputRevision === request.inputRevision &&
      latest.brief === request.brief &&
      JSON.stringify(latest.prerequisites) === JSON.stringify(request.prerequisites)
    )
      return latest;
    const mandatory: Record<string, string> = {
      'pr-merge': 'pr-quality',
      'final-records': 'pr-merge',
      'preservation-cleanup': 'final-records',
    };
    if (
      (request.stage === 'planning' || request.stage === 'integrated-acceptance') &&
      run.subject.kind !== 'epic'
    ) {
      throw new Error(`Stage ${request.stage} requires an EPIC Run`);
    }
    if (request.stage === 'integrated-acceptance') {
      verifyEpicDeliveries(registry, run.id);
    }
    if (
      request.stage === 'pr-quality' &&
      !registry.dispatches.some(
        (d) =>
          d.runId === run.id &&
          d.subject === request.subject &&
          d.role === 'worker' &&
          d.lifecycle === 'accepted',
      )
    )
      throw new Error('Missing mandatory accepted Worker implementation');
    if (
      (request.role === 'pipeline-audit' || request.role === 'pipeline-refactor') &&
      (!run.epicClosure || (run.epicClosure.status !== undefined && run.epicClosure.status !== 'closed'))
    )
      throw new Error('Pipeline requires verified EPIC closure');
    if (
      request.role === 'research-state' &&
      (!run.epicClosure ||
        (run.epicClosure.status !== undefined && run.epicClosure.status !== 'closed') ||
        !run.pipeline ||
        !pipelineAccepted(run.pipeline))
    )
      throw new Error('Report requires accepted Pipeline disposition');
    const predecessor = mandatory[request.stage];
    if (
      predecessor &&
      !registry.dispatches.some(
        (d) =>
          d.runId === run.id &&
          d.subject === request.subject &&
          d.stage === predecessor &&
          d.lifecycle === 'accepted' &&
          (request.stage !== 'pr-merge' || d.inputRevision === request.inputRevision),
      )
    )
      throw new Error('Missing mandatory accepted predecessor: ' + predecessor);
    for (const prerequisite of request.prerequisites) {
      const d = findDispatch(registry, prerequisite);
      if (d.runId !== run.id || d.lifecycle !== 'accepted')
        throw new Error('Unaccepted prerequisite');
    }
    if (latest) {
      // Changed inputs never authorize replacing a possibly live process.
      if (latest.lifecycle !== 'accepted' && latest.lifecycle !== 'rejected')
        throw new Error('Prior generation occupancy unresolved');
      latest.lifecycle = 'superseded';
    }
    reserveSubject(registry, run.id, request.subject);
    const checkout = workflowSource(config, request.checkout ?? config.project);
    reserveRunCheckout(config, run.id, request.authority, checkout, registry);
    const id = randomUUID();
    const directory = join(home(config), 'dispatches', id);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'brief.md');
    writeFileSync(path, request.brief, { flag: 'wx', mode: 0o400 });
    const attempt: ManagedAttempt = {
      id: randomUUID(),
      fleet: createHash('sha256').update(config.file).digest('hex'),
      run: run.id,
      role: request.role,
      runner: run.provider,
      ...(run.dangerouslySkipPermissions
        ? { dangerouslySkipPermissions: true, providerState: { dangerouslySkipPermissions: true } }
        : {}),
      dispatchId: id,
      persistent: !!runner.result,
      ...(runner.separateActivation || runner.result ? { startupGate: true } : {}),
      brief: request.brief,
      initialization: runner.result
        ? {
            registry: join(home(config), 'registry.json'),
            authority: run.orchestratorId,
            run: run.id,
            subject: request.subject,
            role: request.role,
            attempt: '',
            revision: request.inputRevision,
            briefHash: createHash('sha256').update(request.brief).digest('hex'),
            context: { path, hash: createHash('sha256').update(request.brief).digest('hex') },
          }
        : undefined,
      status: 'starting',
      created: new Date().toISOString(),
      directory,
      checkout,
      terminalSession: request.terminalSession,
      writableDirectories: request.writableDirectories,
    };
    if (attempt.initialization) {
      attempt.initialization.attempt = attempt.id;
    }
    const next: StageDispatch = {
      ...request,
      id,
      generation: previous.length + 1,
      provider: run.provider,
      briefReference: { path, hash: createHash('sha256').update(request.brief).digest('hex') },
      attempts: [attempt],
      lifecycle: 'reserved',
    };
    registry.dispatches.push(next);
    launch = true;
    return next;
  });
  if (!launch) {
    ensureStartupRecovery(config, runner, dispatch.runId);
    return dispatch;
  }
  const attempt = dispatch.attempts[0];
  if (
    owningRun.constraints?.kind === 'demo' &&
    request.role === 'worker' &&
    request.stage !== 'final-records'
  ) {
    const roundRoot = dirname(config.project);
    const authFile = resolveGateAuthFile(roundRoot, request.subject);
    if (existsSync(authFile)) {
      const auth = JSON.parse(readFileSync(authFile, 'utf8'));
      auth.claimed = true;
      auth.claimedAt = new Date().toISOString();
      auth.claimedLaunchId = dispatch.id;
      auth.claimedAttemptId = attempt.id;
      writeFileSync(authFile, JSON.stringify(auth, null, 2));

      // Also ensure default and stage-specific authorization files with matching id/issue are marked claimed
      const filesToUpdate = new Set([
        join(roundRoot, 'gate-authorization.json'),
        join(roundRoot, 'gate-worker1-authorization.json'),
        join(roundRoot, 'gate-worker2-authorization.json'),
      ]);
      filesToUpdate.delete(authFile);
      for (const otherPath of filesToUpdate) {
        if (existsSync(otherPath)) {
          try {
            const other = JSON.parse(readFileSync(otherPath, 'utf8'));
            if (other.id === auth.id || other.issue === auth.issue) {
              Object.assign(other, {
                claimed: true,
                claimedAt: auth.claimedAt,
                claimedLaunchId: auth.claimedLaunchId,
                claimedAttemptId: auth.claimedAttemptId,
              });
              writeFileSync(otherPath, JSON.stringify(other, null, 2));
            }
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
  try {
    const ack = await runner.start(attempt);
    if (!ack.conversation || !ack.address || !ack.evidence)
      throw new Error('Missing startup acknowledgement');
    Object.assign(attempt, ack);
    if (attempt.initialization) verifyRoleInitialization(attempt);
    Object.assign(attempt, ack, { status: 'running' });
  } catch (error) {
    attempt.status = 'unknown';
    attempt.error = String(error);
  }
  const result = updateRunRegistry(config, (registry) => {
    const current = findDispatch(registry, dispatch.id);
    current.attempts[0] = attempt;
    current.lifecycle = attempt.status === 'running' ? 'running' : 'reserved';
    return current;
  });
  ensureStartupRecovery(config, runner, dispatch.runId);
  return result;
}

/** Publish the immutable claim before the durable completion event. */
export function publishStageReceipt(
  config: FleetConfig,
  claim: Omit<StageReceipt, 'id'>,
): StageReceipt {
  return updateRunRegistry(config, (registry) => {
    const dispatch = findDispatch(registry, claim.dispatchId);
    if (!dispatch.attempts.some((a) => a.id === claim.attemptId))
      throw new Error('Unknown Attempt');
    if (
      !['completed', 'changes_needed', 'blocked'].includes(claim.outcome) ||
      !Array.isArray(claim.evidence)
    )
      throw new Error('Invalid receipt schema');
    if (
      claim.corrects &&
      !registry.receipts?.some((r) => r.id === claim.corrects && r.dispatchId === dispatch.id)
    )
      throw new Error('Invalid correction lineage');
    const receipt = { ...claim, id: randomUUID() };
    const path = join(home(config), 'dispatches', dispatch.id, receipt.id + '.json');
    const temporary = path + '.tmp';
    writeFileSync(temporary, JSON.stringify(receipt), { flag: 'wx', mode: 0o400 });
    renameSync(temporary, path);
    (registry.receipts ??= []).push(receipt);
    (registry.stageEvents ??= []).push({ receiptId: receipt.id, kind: 'reported' });
    if (dispatch.lifecycle !== 'accepted' && dispatch.lifecycle !== 'superseded')
      dispatch.lifecycle = 'reported';
    return receipt;
  });
}

/** Accept only after current facts, identities, inputs and evidence have been checked. */
export async function acceptStageReceipt(
  config: FleetConfig,
  authority: string,
  receiptId: string,
  verify: (dispatch: StageDispatch, receipt: StageReceipt) => Promise<StageFacts>,
  runner: RunnerAdapter,
): Promise<void> {
  const snapshot = inspectRuns(config);
  const receipt = snapshot.receipts?.find((r) => r.id === receiptId);
  if (!receipt) throw new Error('Unknown Receipt');
  const dispatch = findDispatch(snapshot, receipt.dispatchId);
  authorize(snapshot, dispatch.runId, authority, dispatch.stage === 'preservation-cleanup');
  const release = async () => {
    const current = findDispatch(inspectRuns(config), dispatch.id);
    if (
      current.attempts.at(-1)?.persistent &&
      !current.messages?.some((m) => m.status !== 'completed')
    )
      await stopAcceptedExecution(
        config,
        runner,
        current.id,
        authority,
      );
  };
  if (dispatch.acceptedReceipt === receiptId) {
    await release();
    return;
  }
  const facts = await verify(dispatch, receipt);
  let rejection: string | undefined;
  updateRunRegistry(config, (registry) => {
    const current = findDispatch(registry, dispatch.id);
    authorize(registry, current.runId, authority, current.stage === 'preservation-cleanup');
    if (current.acceptedReceipt === receiptId) return;
    if (registry.revision !== snapshot.revision)
      throw new Error('Registry changed during fact verification; retry');
    const identity =
      receipt.runId === current.runId &&
      receipt.subject === current.subject &&
      receipt.role === current.role &&
      receipt.stage === current.stage &&
      receipt.provider === current.provider &&
      receipt.attemptId === current.attempts.at(-1)?.id;
    const evidence =
      receipt.evidence.length > 0 &&
      receipt.evidence.every((e) => {
        try {
          return createHash('sha256').update(readFileSync(e.path)).digest('hex') === e.hash;
        } catch {
          return false;
        }
      });
    const briefValid =
      createHash('sha256').update(readFileSync(current.briefReference.path)).digest('hex') ===
      current.briefReference.hash;
    const prerequisitesValid = current.prerequisites.every(
      (id) => findDispatch(registry, id).lifecycle === 'accepted',
    );
    if (
      !briefValid ||
      !prerequisitesValid ||
      !identity ||
      !evidence ||
      !facts.ownership ||
      !facts.evidence ||
      receipt.outcome !== 'completed' ||
      current.lifecycle === 'superseded' ||
      (!!current.acceptedReceipt &&
        !(
          receipt.corrects === current.acceptedReceipt &&
          receipt.messageIds?.some((id) =>
            current.messages?.some(
              (m) => m.id === id && m.attemptId === receipt.attemptId && m.status !== 'completed',
            ),
          )
        )) ||
      receipt.inputRevision !== current.inputRevision ||
      facts.currentRevision !== current.inputRevision
    )
      rejection = 'Rejected stale, unsupported or unauthorized Receipt';
    const alreadyRejected = registry.acknowledgements?.some(
      (a) => a.receiptId === receiptId && !a.accepted,
    );
    if (rejection && !alreadyRejected) {
      const prior = current.remediation;
      const consecutive = (prior?.consecutive ?? 0) + 1;
      const limit = prior?.limit ?? 3;
      current.remediation = {
        consecutive,
        limit,
        feedback: rejection + '; supply current version, valid ownership and evidence before retry',
        exhausted: consecutive >= limit,
      };
    }
    (registry.acknowledgements ??= []).push({
      id: randomUUID(),
      receiptId,
      accepted: !rejection,
      evidence: facts.evidence,
      reason: rejection,
    });
    if (!rejection) {
      for (const message of current.messages ?? []) {
        if (message.attemptId === receipt.attemptId && receipt.messageIds?.includes(message.id))
          message.status = 'completed';
      }
      current.acceptedReceipt = receiptId;
      current.lifecycle = 'accepted';
      if (current.stage === 'preservation-cleanup') {
        const run = registry.runs.find((r) => r.id === current.runId);
        if (run && run.subject.kind === 'issue') {
          run.phase = 'completed';
          run.lifecycle = 'completed';
        }
      }
      if (current.remediation) {
        current.remediation.consecutive = 0;
        current.remediation.exhausted = false;
      }
    } else if (current.lifecycle !== 'accepted' && current.lifecycle !== 'superseded')
      current.lifecycle = 'rejected';
  });
  if (rejection) throw new Error(rejection);
  await release();
}

/** Retry unchanged inputs only after independently verified termination; retain every Attempt. */
export async function retryStage(
  config: FleetConfig,
  runner: RunnerAdapter,
  dispatchId: string,
  authority: string,
  stopped: (attempt: ManagedAttempt) => Promise<boolean>,
  options: StageRetryOptions = {},
): Promise<StageDispatch> {
  const snapshot = inspectRuns(config);
  const dispatch = findDispatch(snapshot, dispatchId);
  const run = authorize(snapshot, dispatch.runId, authority);
  if (runner.name !== run.provider)
    throw new Error(
      `Run provider mismatch: expected provider ${run.provider}, but received ${runner.name}`,
    );
  if (run.constraints?.kind === 'demo') {
    throw new Error('Stage retries prohibited for demo-constrained Runs');
  }
  requireInteractive(runner);
  await runner.preflight();
  if (dispatch.remediation?.exhausted)
    throw new Error('Remediation exhausted: ' + dispatch.remediation.feedback);
  const prior = dispatch.attempts.at(-1)!;
  if (!(await stopped(prior))) throw new Error('Prior Attempt occupancy unresolved');
  const attempt = updateRunRegistry(config, (registry) => {
    const current = findDispatch(registry, dispatchId);
    authorize(registry, dispatch.runId, authority);
    if (run.constraints?.kind === 'demo') {
      const roundRoot = dirname(config.project);
      const controlFile = join(roundRoot, 'control.json');
      if (existsSync(controlFile)) {
        const control = JSON.parse(readFileSync(controlFile, 'utf8'));
        if (control.stopped || control.releasing || control.activeMs >= control.budgetMs) {
          throw new Error(
            `Demo round ${run.constraints.roundId} is stopped or expired; cannot retry stage`,
          );
        }
      }
      if (current.role === 'worker') {
        const boundaryFile = join(roundRoot, 'delivery-boundaries.jsonl');
        const boundaries = existsSync(boundaryFile)
          ? readFileSync(boundaryFile, 'utf8')
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line))
          : [];
        if (!boundaries.some((b: { pass?: boolean }) => b.pass === true)) {
          throw new Error(
            `Worker dispatch denied: matching Gate authorization required for demo round ${run.constraints.roundId}`,
          );
        }
      }
    }
    if (
      registry.revision !== snapshot.revision ||
      current.acceptedReceipt ||
      current.lifecycle === 'superseded'
    )
      throw new Error('Retry inputs changed or already accepted');
    const id = randomUUID();
    const directory = join(home(config), 'dispatches', dispatchId, id);
    mkdirSync(directory);
    const next: ManagedAttempt = {
      ...prior,
      predecessor: prior.id,
      ...(runner.separateActivation || runner.result || prior.startupGate ? { startupGate: true } : {}),
      activation: undefined,
      startupStopped: undefined,
      id,
      directory,
      status: 'starting',
      created: new Date().toISOString(),
      brief: assignmentWithRequirements(
        run,
        `Reconcile durable Dispatch ${current.id} evidence before continuing. Scope reference: ${current.briefReference.path}. Do not replay the original brief or repeat accepted work.`,
      ),
      conversation: options.replaceConversation ? undefined : prior.conversation,
      address: undefined,
      evidence: undefined,
      error: undefined,
    };
    if (next.initialization) {
      next.initialization = { ...next.initialization, attempt: next.id };
    }
    current.attempts.push(next);
    current.lifecycle = 'reserved';
    return next;
  });
  try {
    const ack = await runner.start(attempt);
    if (!ack.conversation || !ack.address || !ack.evidence)
      throw new Error('Missing startup acknowledgement');
    Object.assign(attempt, ack);
    if (attempt.initialization) verifyRoleInitialization(attempt);
    Object.assign(attempt, ack, { status: 'running' });
  } catch (error) {
    attempt.status = 'unknown';
    attempt.error = String(error);
  }
  const result = updateRunRegistry(config, (registry) => {
    const current = findDispatch(registry, dispatchId);
    current.attempts[current.attempts.length - 1] = attempt;
    current.lifecycle = attempt.status === 'running' ? 'running' : 'reserved';
    return current;
  });
  ensureStartupRecovery(config, runner, dispatch.runId);
  return result;
}

/** Set a bounded repair policy without erasing previously unsuccessful attempts. */
export function setRemediationLimit(
  config: FleetConfig,
  runId: string,
  authority: string,
  dispatchId: string,
  limit: number,
): void {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error('Expected positive remediation limit');
  updateRunRegistry(config, (registry) => {
    authorize(registry, runId, authority);
    const dispatch = findDispatch(registry, dispatchId);
    if (dispatch.runId !== runId) throw new Error('Wrong Run');
    const consecutive = dispatch.remediation?.consecutive ?? 0;
    dispatch.remediation = {
      consecutive,
      limit,
      exhausted: consecutive >= limit,
      feedback: dispatch.remediation?.feedback ?? '',
    };
  });
}

/** Launch a business turn only through its validated owning Run. */
export async function startBusinessTurn(
  config: FleetConfig,
  runner: RunnerAdapter,
  attempt: ManagedAttempt,
  repository: string,
  number: number,
): Promise<ManagedAttempt> {
  const owner = orchestratorForSubject(config, repository, number);
  if (!owner?.run)
    throw new Error(
      `No Run owns ${repository}#${number}; run pc workflow orchestrator start ${number} --type <issue|epic> --provider <provider> --config ${config.file}`,
    );
  if (owner.runner !== runner.name)
    throw new Error(
      `Run provider mismatch: expected provider ${owner.runner}, but received ${runner.name}`,
    );
  const dispatch = await dispatchStage(config, runner, {
    runId: owner.run,
    authority: owner.id,
    subject: `${repository}#${number}`,
    role: attempt.role,
    stage:
      'business-' +
      attempt.role +
      '-' +
      createHash('sha256').update(attempt.brief).digest('hex').slice(0, 16),
    inputRevision: createHash('sha256').update(attempt.brief).digest('hex'),
    brief: attempt.brief,
    prerequisites: [],
    checkout: attempt.checkout,
    terminalSession: attempt.terminalSession,
    writableDirectories: attempt.writableDirectories,
  });
  return Object.assign(attempt, dispatch.attempts.at(-1));
}

/** Publish collected evidence; accept only after explicit domain validation. */
export async function collectBusinessTurn(
  config: FleetConfig,
  runner: RunnerAdapter,
  attempt: ManagedAttempt,
  validate?: (result: string) => void,
  options?: CollectBusinessTurnOptions,
): Promise<string> {
  const registryAttempt = attempt.dispatchId
    ? inspectRuns(config).dispatches?.find((d) => d.id === attempt.dispatchId)?.attempts.find((a) => a.id === attempt.id)
    : inspectRuns(config).runs.find((r) => r.id === attempt.run)?.orchestrator;
  const current = registryAttempt ?? attempt;
  if (
    current.status !== 'running' ||
    (current.startupGate && current.activation?.status !== 'delivered')
  ) {
    throw new Error(
      'Attempt startup incomplete: activation delivery required before business execution',
    );
  }
  const result = await runner.collect(attempt, {
    timeoutMs: options?.timeoutMs,
    dispatchId: attempt.dispatchId,
  });
  if (result === undefined) throw new Error('No correlated task result; execution remains pending');
  const dispatch = inspectRuns(config).dispatches?.find((d) =>
    d.attempts.some((a) => a.id === attempt.id),
  );
  if (dispatch && dispatch.lifecycle !== 'accepted') {
    const path = join(attempt.directory, 'business-result-' + randomUUID() + '.md');
    writeFileSync(path, result, { flag: 'wx', mode: 0o400 });
    const receipt = publishStageReceipt(config, {
      dispatchId: dispatch.id,
      attemptId: attempt.id,
      runId: dispatch.runId,
      subject: dispatch.subject,
      role: dispatch.role,
      stage: dispatch.stage,
      provider: dispatch.provider,
      inputRevision: dispatch.inputRevision,
      outcome: 'completed',
      messageIds: options?.messageIds,
      evidence: [{ path, hash: createHash('sha256').update(result).digest('hex') }],
    });
    if (!validate) return result;
    validate(result);
    await acceptStageReceipt(
      config,
      dispatch.authority,
      receipt.id,
      async () => ({
        currentRevision: dispatch.inputRevision,
        ownership: true,
        evidence: 'Collected immutable business result under reserved Run authority',
      }),
      runner,
    );
  }
  return result;
}

/** Validate scoped implementation completion before it becomes a PR prerequisite. */
export function validateImplementationResult(
  result: string,
  repository: string,
  issue: number,
): void {
  const value = JSON.parse(result);
  if (
    value.status !== 'completed' ||
    value.repository !== repository ||
    value.issue !== issue ||
    typeof value.evidence !== 'string' ||
    !value.evidence.trim()
  )
    throw new Error(
      'Expected completed implementation with matching repository/Issue and evidence',
    );
}

/** Accept published turns only at a caller's validated domain completion boundary. */
export async function acceptValidatedBusinessTurns(
  config: FleetConfig,
  attempts: ManagedAttempt[],
  domainEvidence: string,
  runner: RunnerAdapter,
): Promise<void> {
  if (!domainEvidence.trim()) throw new Error('Domain acceptance evidence required');
  for (const attempt of attempts) {
    const registry = inspectRuns(config);
    const dispatch = registry.dispatches?.find((d) => d.attempts.some((a) => a.id === attempt.id));
    if (!dispatch || (dispatch.lifecycle === 'accepted' && !dispatch.attempts.at(-1)?.persistent))
      continue;
    const receipt = dispatch.acceptedReceipt
      ? registry.receipts?.find((r) => r.id === dispatch.acceptedReceipt)
      : registry.receipts?.filter((r) => r.dispatchId === dispatch.id).at(-1);
    if (!receipt) throw new Error('Business completion receipt missing');
    await acceptStageReceipt(
      config,
      dispatch.authority,
      receipt.id,
      async () => ({
        currentRevision: dispatch.inputRevision,
        ownership: true,
        evidence: domainEvidence,
      }),
      runner,
    );
  }
}

/** Persist intent before sending; repeated IDs reconcile rather than replay uncertain input. */
export async function sendStageMessage(
  config: FleetConfig,
  runner: RunnerAdapter,
  dispatchId: string,
  authority: string,
  message: StageMessageInput,
): Promise<void> {
  if (!message.id.trim() || !message.brief.trim())
    throw new Error('Expected message identity and complete brief');
  if (!runner.interactive || !runner.send)
    throw new Error('Runner lacks persistent interactive input');
  let send = false;
  let attemptToReconcile: ManagedAttempt | undefined;
  const attempt = updateRunRegistry(config, (registry) => {
    const dispatch = findDispatch(registry, dispatchId);
    authorize(registry, dispatch.runId, authority);
    if (dispatch.provider !== runner.name)
      throw new Error(
        `Run provider mismatch: expected provider ${dispatch.provider}, but received ${runner.name}`,
      );
    if (dispatch.lifecycle === 'accepted')
      throw new Error('Accepted task requires a new Dispatch for follow-up assignment');
    const existing = dispatch.messages?.find((m) => m.id === message.id);
    if (existing) {
      if (existing.brief !== message.brief)
        throw new Error('Message identity already bound to different input');
      if (existing.status !== 'delivered' && existing.status !== 'completed') {
        attemptToReconcile = dispatch.attempts.at(-1)!;
      }
    } else {
      (dispatch.messages ??= []).push({
        ...message,
        attemptId: dispatch.attempts.at(-1)!.id,
        status: 'pending',
      });
      send = true;
    }
    return dispatch.attempts.at(-1)!;
  });
  if (!send) {
    if (!attemptToReconcile) return;
    // Uncertain delivery is reconciled before retrying.
    if (runner.messageReceipt) {
      const evidence = await runner.messageReceipt(attemptToReconcile, message);
      if (evidence) {
        updateRunRegistry(config, (registry) => {
          const dispatch = findDispatch(registry, dispatchId);
          const persisted = dispatch.messages!.find((m) => m.id === message.id)!;
          persisted.status = 'delivered';
          persisted.evidence = evidence;
        });
        return;
      }
      // Reconciled as NOT delivered; safe to proceed with sending
    } else {
      // Cannot reconcile uncertain delivery without messageReceipt capability; forbidden to replay
      return;
    }
  }
  let status: 'delivered' | 'uncertain' = 'uncertain';
  let evidence: string;
  try {
    const delivery = await runner.send(attempt, message);
    if (!delivery.evidence) throw new Error('Missing delivery evidence');
    status = delivery.status;
    evidence = delivery.evidence;
  } catch (error) {
    evidence = String(error);
  }
  updateRunRegistry(config, (registry) => {
    const dispatch = findDispatch(registry, dispatchId);
    const persisted = dispatch.messages!.find((m) => m.id === message.id)!;
    Object.assign(persisted, { status, evidence });
  });
}

/** Reconcile uncertain stage message delivery using adapter receipt evidence without replay. */
export async function reconcileStageMessage(
  config: FleetConfig,
  runner: RunnerAdapter,
  dispatchId: string,
  authority: string,
  messageId: string,
): Promise<ReconcileStageMessageResult> {
  const snapshot = inspectRuns(config);
  const dispatch = findDispatch(snapshot, dispatchId);
  authorize(snapshot, dispatch.runId, authority);
  const message = dispatch.messages?.find((m) => m.id === messageId);
  if (!message) throw new Error(`Unknown message ${messageId} in dispatch ${dispatchId}`);
  if (message.status === 'delivered' || message.status === 'completed') {
    return { status: 'delivered', evidence: message.evidence };
  }
  const attempt = dispatch.attempts.at(-1)!;
  if (!runner.messageReceipt) {
    return { status: 'uncertain', evidence: message.evidence };
  }
  const evidence = await runner.messageReceipt(attempt, message);
  if (evidence) {
    updateRunRegistry(config, (registry) => {
      const d = findDispatch(registry, dispatchId);
      const m = d.messages?.find((item) => item.id === messageId);
      if (m) {
        m.status = 'delivered';
        m.evidence = evidence;
      }
    });
    return { status: 'delivered', evidence };
  }
  return { status: 'uncertain', evidence: message.evidence };
}

/** Verify accepted execution shutdown while retaining checkout ownership for preservation. */
export async function stopAcceptedExecution(
  config: FleetConfig,
  runner: RunnerAdapter,
  dispatchId: string,
  authority: string,
): Promise<void> {
  const registry = inspectRuns(config);
  const dispatch = findDispatch(registry, dispatchId);
  authorize(registry, dispatch.runId, authority);
  if (runner.name !== dispatch.provider)
    throw new Error(
      `Run provider mismatch: expected provider ${dispatch.provider}, but received ${runner.name}`,
    );
  if (dispatch.lifecycle !== 'accepted' || dispatch.messages?.some((m) => m.status !== 'completed'))
    throw new Error('Acceptance and reconciled input required before release');
  const attempt = dispatch.attempts.at(-1)!;
  if (!runner.stopped && !runner.terminate) throw new Error('Verified termination capability required');
  const term = await terminateAttempt(attempt, runner);
  if (term.status !== 'terminated') {
    throw new Error('Unknown termination; checkout remains occupied');
  }
  // Execution capacity and checkout ownership are independent lifecycle gates.
}

/** Release only through explicit verified workflow cleanup after execution shutdown. */
export async function releaseAcceptedExecution(
  config: FleetConfig,
  runner: RunnerAdapter,
  dispatchId: string,
  authority: string,
  cleanup?: () => void,
): Promise<void> {
  await stopAcceptedExecution(config, runner, dispatchId, authority);
  if (!cleanup)
    throw new Error('Checkout release requires the workflow preservation and cleanup gate');
  const dispatch = findDispatch(inspectRuns(config), dispatchId);
  const attempt = dispatch.attempts.at(-1)!;
  if (
    !inspectRuns(config).resources?.some(
      (r) => r.runId === dispatch.runId && r.path === attempt.checkout,
    )
  )
    return;
  await releaseRunCheckout(
    config,
    dispatch.runId,
    attempt.checkout,
    runner.stopped!.bind(runner),
    cleanup,
  );
}
