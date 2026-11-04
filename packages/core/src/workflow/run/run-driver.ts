import { execFileSync } from 'node:child_process';
import { writeResearchReport } from '../delivery/research-report.js';
import { assertStageRole } from '../runtime/workflow-role.js';
import { verifyRoleInitialization } from './role-initialization.js';
/** Run intake and authoritative Fleet relationships; managed execution belongs to one Run. */
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { workflowSource, type FleetConfig } from '../fleet/fleet-config.js';
import {
  requireInteractive,
  terminateAttempt,
  reconcileAttempt,
  inspectAttemptControl,
  type ManagedAttempt,
  type RunnerAdapter,
  type AttemptControl,
  type ExecutionTermination,
} from '../runtime/runtime.js';
import { pipelineAccepted, type PipelineDisposition } from '../delivery/epic-finalization.js';
import {
  home,
  inspectRuns,
  updateRunRegistry,
  reserveSubject,
  type RunSubject,
  type RunConstraints,
  type WorkflowRun,
  type RunRegistry,
  type StageRequest,
  type StageDispatch,
  type StageReceipt,
  type StageFacts,
} from './run-registry.js';
import {
  assignmentWithRequirements,
  ensureStartupRecovery,
  stopStartupRecovery,
  startupRecoveryStatus,
} from './startup.js';

export {
  home,
  inspectRuns,
  updateRunRegistry,
  save,
  reserveSubject,
  claimDriver,
  validateRegistryRoles,
  type RunSubject,
  type RunConstraints,
  type WorkflowRun,
  type RunRegistry,
  type StageRequest,
  type StageDispatch,
  type StageReceipt,
  type StageFacts,
} from './run-registry.js';
export {
  startRun,
  verifyRunRequirements,
  assignmentWithRequirements,
} from './startup.js';
export {
  recoverRun,
  recoverAllRuns,
} from './recovery.js';
function findDispatch(registry: RunRegistry, id: string): StageDispatch {
  const dispatch = registry.dispatches?.find((d) => d.id === id);
  if (!dispatch) throw new Error('Unknown Dispatch');
  return dispatch;
}
function authorize(
  registry: RunRegistry,
  runId: string,
  authority: string,
  allowCompleted = false,
): WorkflowRun {
  const run = registry.runs.find((r) => r.id === runId);
  if (
    !run ||
    run.orchestratorId !== authority ||
    (run.lifecycle !== 'running' && (!allowCompleted || run.lifecycle !== 'completed'))
  )
    throw new Error('Inactive or wrong Orchestrator authority');
  return run;
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
    reserveCheckout(config, registry, run.id, checkout);
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
  options: { replaceConversation?: boolean } = {},
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


function reserveCheckout(
  config: FleetConfig,
  registry: RunRegistry,
  runId: string,
  checkout: string,
): void {
  const path = join(realpathSync(checkout), '.pc-execution-owner');
  const owner = { path: checkout, runId, registry: join(home(config), 'registry.json') };
  try {
    writeFileSync(path, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let prior;
    try {
      prior = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new Error('Unknown checkout occupancy', { cause: error });
    }
    if (prior.runId !== runId || prior.registry !== owner.registry)
      throw new Error(`Checkout occupied: ${checkout}`, { cause: error });
  }
  registry.resources ??= [];
  if (!registry.resources.some((r) => r.path === checkout)) registry.resources.push(owner);
}
/** Release requires independent termination evidence for every execution using the checkout. */
export async function releaseRunCheckout(
  config: FleetConfig,
  runId: string,
  checkout: string,
  stopped: (attempt: ManagedAttempt) => Promise<boolean>,
  cleanup?: () => void,
): Promise<void> {
  const physical = workflowSource(config, checkout);
  const snapshot = inspectRuns(config);
  const run = snapshot.runs.find((r) => r.id === runId);
  const attempts = [
    ...(snapshot.dispatches?.filter((d) => d.runId === runId).flatMap((d) => d.attempts) ?? []),
    ...[run?.orchestrator, ...(run?.priorOrchestrators ?? [])].filter(
      (a): a is ManagedAttempt => !!a,
    ),
  ].filter((a) => a.checkout === physical);
  if (!attempts.length || !(await Promise.all(attempts.map(stopped))).every(Boolean))
    throw new Error('Unknown checkout occupancy; termination evidence required');
  updateRunRegistry(config, (registry) => {
    if (registry.revision !== snapshot.revision) throw new Error('Ownership changed; retry');
    const path = join(physical, '.pc-execution-owner');
    const owner = JSON.parse(readFileSync(path, 'utf8'));
    if (owner.runId !== runId || owner.registry !== join(home(config), 'registry.json'))
      throw new Error('Checkout owner conflict');
    cleanup?.();
    rmSync(path, { force: true });
    registry.resources = registry.resources?.filter((r) => r.path !== physical);
  });
}

/** Find subject ownership for existing internal workflow projections. */
function findSubjectOrchestrator(
  config: FleetConfig,
  repository: string,
  number: number,
): ManagedAttempt | undefined {
  const registry = inspectRuns(config);
  const owner = registry.subjects?.find((s) => s.subject === `${repository}#${number}`)?.ownerRunId;
  const run = registry.runs.find(
    (r) =>
      r.id === owner ||
      (!owner &&
        r.subject.repository === repository &&
        r.subject.number === number &&
        r.lifecycle !== 'completed'),
  );
  return run?.orchestrator;
}

/** Require an active subject Run and its recorded provider before command dispatch. */
export function orchestratorForSubject(
  config: FleetConfig,
  repository: string,
  number: number,
): ManagedAttempt {
  const attempt = findSubjectOrchestrator(config, repository, number);
  const run = inspectRuns(config).runs.find((r) => r.id === attempt?.run);
  const next = `pc workflow orchestrator start ${number} --type <issue|epic> --provider <provider> --config ${config.file}`;
  if (!run) throw new Error(`No Run owns ${repository}#${number}; run ${next}`);
  if (!run.provider)
    throw new Error('Missing Run provider');
  if (run.lifecycle === 'completed')
    throw new Error(`Completed Run ${run.id} authority has ended; start later work with ${next}`);
  if (run.lifecycle !== 'running' || !run.orchestrator || run.orchestrator.status !== 'running')
    throw new Error(
      `No active Orchestrator for Run ${run.id}; run pc workflow orchestrator recover ${run.id} --config ${config.file}`,
    );
  if (run.orchestrator.runner !== run.provider)
    throw new Error(
      `Run provider mismatch: expected provider ${run.provider}, but received ${run.orchestrator.runner}`,
    );
  return run.orchestrator;
}
/** Record a consuming Run reference without granting another execution owner. */
export function referenceRunSubject(config: FleetConfig, runId: string, subject: string): string {
  return updateRunRegistry(config, (registry) => {
    if (!registry.runs.some((r) => r.id === runId))
      throw new Error(`Unknown Run: expected existing run with id ${runId}`);
    registry.subjects ??= [];
    const owner = registry.subjects.find((s) => s.subject === subject);
    if (!owner) return reserveSubject(registry, runId, subject);
    if (owner.ownerRunId !== runId && !owner.consumingRunIds.includes(runId))
      owner.consumingRunIds.push(runId);
    return owner.ownerRunId;
  });
}

/** Apply the same reservation guard to existing Issue/EPIC worker-driver launches. */
export function reserveRunCheckout(
  config: FleetConfig,
  runId: string,
  authority: string,
  checkout: string,
): void {
  const physical = workflowSource(config, checkout);
  updateRunRegistry(config, (registry) => {
    authorize(registry, runId, authority);
    reserveCheckout(config, registry, runId, physical);
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
  options?: { timeoutMs?: number; messageIds?: string[] },
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
  message: { id: string; brief: string },
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
): Promise<{ status: 'delivered' | 'uncertain'; evidence?: string }> {
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

/** Actions seam for actual native EPIC closure, verification and head resolution. */
export interface EpicClosureActions {
  /** Resolve current Git HEAD */
  head?: () => Promise<string> | string;
  /** Check current GitHub issue state without modifying it */
  view?: () => Promise<{ state: string; number?: number }>;
  /** Execute actual close on GitHub */
  close?: () => Promise<void>;
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

/** Retrieve all completed or required deliveries associated with an EPIC run (including referenced external deliveries). */
export function epicDeliveries(
  registry: RunRegistry,
  runId: string,
): NonNullable<RunRegistry['deliveries']> {
  const children = epicChildSubjects(registry, runId);
  const allDeliveries = registry.deliveries ?? [];
  const result: NonNullable<RunRegistry['deliveries']> = [];

  for (const d of allDeliveries) {
    if (d.runId === runId) {
      result.push(d);
    }
  }

  for (const child of children) {
    const [repo, numStr] = child.split('#');
    const num = Number(numStr);
    const d = allDeliveries.find((del) => del.repository === repo && del.issue === num);
    if (
      d &&
      !result.some(
        (existing) =>
          existing === d || (existing.repository === d.repository && existing.issue === d.issue),
      )
    ) {
      result.push(d);
    }
  }

  result.sort((a, b) => {
    const repoCmp = a.repository.localeCompare(b.repository);
    if (repoCmp !== 0) return repoCmp;
    return a.issue - b.issue;
  });

  return result;
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

/** Canonical accepted delivery fingerprint for closure request, human consent, native close, and recorded closure. */
export function canonicalDeliveryFingerprint(head: string, deliveries: unknown[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ head, deliveries }))
    .digest('hex');
}

/** Record explicit human confirmation bound to delivery version on an EPIC Run. */
export function confirmStageEpic(
  config: FleetConfig,
  runId: string,
  authority: string,
  confirmation: { deliveryVersion: string; source: 'human'; evidence: string },
) {
  const snapshot = inspectRuns(config);
  const run = authorize(snapshot, runId, authority);
  if (run.subject.kind !== 'epic') {
    throw new Error('Only EPIC runs accept delivery confirmation');
  }
  if (
    !confirmation ||
    confirmation.source !== 'human' ||
    !confirmation.deliveryVersion?.trim() ||
    !confirmation.evidence?.trim()
  ) {
    throw new Error('Explicit human confirmation with deliveryVersion and evidence required');
  }
  updateRunRegistry(config, (registry) => {
    const current = authorize(registry, runId, authority);
    current.humanConfirmation = confirmation;
  });
}

/** Invalidate cached human confirmation upon delivery revision changes. */
function invalidateHumanConfirmation(config: FleetConfig, runId: string): void {
  updateRunRegistry(config, (registry) => {
    const current = registry.runs.find((r) => r.id === runId);
    if (current?.humanConfirmation) delete current.humanConfirmation;
  });
}

/** Commit externally verified closure after accepted integrated goal judgment and delivery. */
export async function closeStageEpic(
  config: FleetConfig,
  runId: string,
  authority: string,
  dispatchId: string,
  confirmation?: { deliveryVersion: string; source: 'human'; evidence: string },
  observeOrActions?: (() => Promise<{ head: string; closed: boolean; evidence: string }>) | EpicClosureActions,
) {
  const snapshot = inspectRuns(config);
  const run = authorize(snapshot, runId, authority);
  const dispatch = findDispatch(snapshot, dispatchId);
  verifyEpicDeliveries(snapshot, runId);
  const deliveries = epicDeliveries(snapshot, runId);

  if (run.subject.kind !== 'epic') {
    throw new Error('Issue-only Run cannot close or finalize parent EPIC');
  }

  if (run.epicClosure?.status === 'closed') {
    throw new Error(
      'EPIC has already been closed; registration that merely observes an already-closed Parent is not a substitute for actual closure',
    );
  }

  if (
    dispatch.runId !== runId ||
    dispatch.role !== 'epic' ||
    dispatch.stage !== 'integrated-acceptance' ||
    dispatch.lifecycle !== 'accepted'
  ) {
    throw new Error(
      'Active Orchestrator and accepted integrated Dispatch required before GitHub close',
    );
  }

  const receipt = snapshot.receipts!.find((r) => r.id === dispatch.acceptedReceipt)!;
  verifyRetainedStageEvidence(receipt);
  const judgment = JSON.parse(readFileSync(receipt.evidence[0].path, 'utf8'));
  if (
    judgment.satisfied !== true ||
    !judgment.criteria?.length ||
    !Array.isArray(judgment.blockers) ||
    judgment.blockers.length
  ) {
    throw new Error('Integrated goal remains unaccepted');
  }

  if (
    !deliveries.length ||
    deliveries.some((d) => d.status !== 'done' || !d.recorded || !d.released || !d.archive)
  ) {
    throw new Error(
      'Expected accepted integrated goal, completed delivery, current human confirmation and verified closure',
    );
  }

  const humanConf = confirmation ?? run.humanConfirmation;
  if (
    !humanConf ||
    humanConf.source !== 'human' ||
    !humanConf.evidence?.trim() ||
    !humanConf.deliveryVersion?.trim()
  ) {
    throw new Error(
      'Expected accepted integrated goal, completed delivery, current human confirmation and verified closure',
    );
  }

  if (typeof observeOrActions === 'function') {
    const facts = await observeOrActions();
    const version = canonicalDeliveryFingerprint(facts.head, deliveries);
    if (dispatch.inputRevision !== facts.head) {
      if (run.humanConfirmation) {
        invalidateHumanConfirmation(config, runId);
      }
      throw new Error('Delivery changed after acceptance; obtain renewed acceptance and confirmation');
    }
    if (humanConf.deliveryVersion !== version) {
      if (run.humanConfirmation) {
        invalidateHumanConfirmation(config, runId);
      }
      throw new Error(
        `Delivery version mismatch: expected ${version}, but received ${humanConf.deliveryVersion}. Prior confirmation invalidated.`,
      );
    }
    if (!facts.closed || !facts.evidence?.trim()) {
      throw new Error(
        'Expected accepted integrated goal, completed delivery, current human confirmation and verified closure',
      );
    }

    updateRunRegistry(config, (registry) => {
      const current = authorize(registry, runId, authority);
      if (registry.revision !== snapshot.revision)
        throw new Error('Registry changed during closure verification');
      current.epicClosure = {
        deliveryVersion: version,
        head: facts.head,
        evidence: facts.evidence,
        confirmed: humanConf.evidence,
        status: 'closed',
      };
      current.phase = 'post_closure_finalization';
      current.lifecycle = 'running';
      delete current.humanConfirmation;
    });
    return { deliveryVersion: version, head: facts.head };
  }

  const actions = observeOrActions ?? {};
  const projectCwd = config.project;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: projectCwd, encoding: 'utf8', timeout: 10000 }).trim();

  const head = await (actions.head ? actions.head() : git('rev-parse', 'HEAD'));
  if (dispatch.inputRevision !== head) {
    if (run.humanConfirmation) {
      invalidateHumanConfirmation(config, runId);
    }
    throw new Error('Delivery changed after acceptance; obtain renewed acceptance and confirmation');
  }

  const version = canonicalDeliveryFingerprint(head, deliveries);

  if (humanConf.deliveryVersion !== version) {
    if (run.humanConfirmation) {
      invalidateHumanConfirmation(config, runId);
    }
    throw new Error(
      `Delivery version mismatch: expected ${version}, but received ${humanConf.deliveryVersion}. Prior confirmation invalidated.`,
    );
  }

  const viewState = async (): Promise<{ state: string }> => {
    if (actions.view) return actions.view();
    const out = execFileSync(
      'gh',
      ['issue', 'view', String(run.subject.number), '--repo', run.subject.repository, '--json', 'state'],
      { cwd: projectCwd, encoding: 'utf8', timeout: 30000 },
    );
    return JSON.parse(out);
  };

  const closeIssue = async (): Promise<void> => {
    if (actions.close) return actions.close();
    execFileSync('gh', ['issue', 'close', String(run.subject.number), '--repo', run.subject.repository], {
      cwd: projectCwd,
      encoding: 'utf8',
      timeout: 30000,
    });
  };

  // Check if Parent was already closed BEFORE actual closure
  const before = await viewState();
  if (before && before.state?.toLowerCase() === 'closed') {
    throw new Error('Registration that merely observes an already-closed Parent is not a substitute for actual closure');
  }

  // Perform actual close with reconciliation of uncertain results
  let closeError: unknown;
  try {
    await closeIssue();
  } catch (err) {
    closeError = err;
  }

  if (closeError) {
    // Reconcile uncertain close result: check external state
    const reconciled = await viewState();
    if (reconciled && reconciled.state?.toLowerCase() === 'closed') {
      // Reconciled! Closed despite uncertainty
    } else {
      throw closeError;
    }
  }

  // Independently verify closed state
  const after = await viewState();
  if (!after || after.state?.toLowerCase() !== 'closed') {
    throw new Error('Expected verified actual closure; Parent remains open');
  }

  const evidence = `GitHub ${run.subject.repository}#${run.subject.number} actual closure`;

  updateRunRegistry(config, (registry) => {
    const current = authorize(registry, runId, authority);
    if (registry.revision !== snapshot.revision)
      throw new Error('Registry changed during closure verification');
    current.epicClosure = {
      deliveryVersion: version,
      head,
      evidence,
      confirmed: humanConf.evidence,
      status: 'closed',
    };
    current.phase = 'post_closure_finalization';
    current.lifecycle = 'running';
    delete current.humanConfirmation;
  });
  return { deliveryVersion: version, head };
}

/** Retain a validated accepted Pipeline result; receipt acceptance alone is insufficient. */
export function dispositionStagePipeline(
  config: FleetConfig,
  runId: string,
  authority: string,
  dispatchId: string,
) {
  updateRunRegistry(config, (registry) => {
    const run = authorize(registry, runId, authority);
    const dispatch = findDispatch(registry, dispatchId);
    if (
      !run.epicClosure ||
      (run.epicClosure.status !== undefined && run.epicClosure.status !== 'closed') ||
      dispatch.runId !== runId ||
      !['pipeline-audit', 'pipeline-refactor'].includes(dispatch.role) ||
      dispatch.lifecycle !== 'accepted'
    )
      throw new Error('Expected accepted post-closure Pipeline receipt');
    const receipt = registry.receipts!.find((r) => r.id === dispatch.acceptedReceipt)!;
    verifyRetainedStageEvidence(receipt);
    const result = JSON.parse(
      readFileSync(receipt.evidence[0].path, 'utf8'),
    ) as PipelineDisposition;

    if (run.constraints?.kind === 'demo') {
      const roundRoot = dirname(config.project);
      const controlFile = join(roundRoot, 'control.json');
      const isCleanNoChanges =
        ['not_applicable', 'completed_no_changes'].includes(result.disposition) &&
        pipelineAccepted(result) &&
        result.head === run.epicClosure.head &&
        Object.values(result.inspectedVersions ?? {}).includes(run.epicClosure.head) &&
        (receipt.evidence?.length ?? 0) > 0;

      if (!isCleanNoChanges) {
        if (existsSync(controlFile)) {
          const control = JSON.parse(readFileSync(controlFile, 'utf8'));
          control.stopped = true;
          control.stoppedReason =
            result.disposition === 'changes_needed'
              ? 'Pipeline changes require retention; no repair or third delivery'
              : 'Pipeline disposition invalidates acceptance; retaining diagnostic round';
          writeFileSync(controlFile, JSON.stringify(control, null, 2));
        }
        throw new Error(
          result.disposition === 'changes_needed'
            ? 'Pipeline changes require retention; no repair or third delivery'
            : 'Pipeline disposition blocks reporting',
        );
      }
    }

    if (result.head !== run.epicClosure.head || !pipelineAccepted(result))
      throw new Error('Pipeline disposition blocks reporting');
    run.pipeline = result;
  });
}

/** Publish an accepted bounded report through the normal transactional writer and complete business state. */
export async function publishStageReport(
  config: FleetConfig,
  runId: string,
  authority: string,
  dispatchId: string,
  coordinator: { identity: string; entry: string; brief: string },
) {
  const snapshot = inspectRuns(config);
  const run = authorize(snapshot, runId, authority);
  const dispatch = findDispatch(snapshot, dispatchId);
  if (run.report) {
    throw new Error('Research report has already been published; cannot repeat publication');
  }
  if (
    !run.epicClosure ||
    (run.epicClosure.status !== undefined && run.epicClosure.status !== 'closed') ||
    !pipelineAccepted(run.pipeline) ||
    dispatch.runId !== runId ||
    dispatch.role !== 'research-state' ||
    dispatch.lifecycle !== 'accepted' ||
    dispatch.inputRevision !== run.epicClosure.head
  )
    throw new Error('Expected accepted current Research-State result after Pipeline');
  const receipt = snapshot.receipts!.find((r) => r.id === dispatch.acceptedReceipt)!;
  verifyRetainedStageEvidence(receipt);
  const result = JSON.parse(readFileSync(receipt.evidence[0].path, 'utf8'));
  if (
    result.status !== 'completed' ||
    typeof result.artifact !== 'string' ||
    !coordinator.identity.trim() ||
    !coordinator.brief.trim()
  )
    throw new Error('Expected completed report artifact and coordinator-provided judgments');
  if (
    createHash('sha256').update(readFileSync(result.artifact)).digest('hex') !== result.artifactHash
  )
    throw new Error('Report artifact changed since accepted result');

  if (run.constraints?.kind === 'demo') {
    const roundRoot = dirname(config.project);
    const roundFile = join(roundRoot, 'round.json');
    if (existsSync(roundFile)) {
      const round = JSON.parse(readFileSync(roundFile, 'utf8'));
      if (
        coordinator.identity !== round.config.coordinator ||
        coordinator.brief !== round.config.brief ||
        coordinator.entry !== round.entry ||
        realpathSync(round.research) !== round.research ||
        dirname(round.entry) !== round.research ||
        round.entry !== join(round.research, 'report.md')
      ) {
        throw new Error('Isolated physical report destination and operator coordinator configuration required');
      }
    }

    const artifactContent = readFileSync(result.artifact, 'utf8');
    const hasSummaryValues =
      /\b10\b/.test(artifactContent) &&
      /\b55\b/.test(artifactContent) &&
      /\b100\b/.test(artifactContent);
    const hasReferences = /#\d+|PR\s*\d+|Issue\s*\d+/i.test(artifactContent);
    const hasPipelineConclusion = /(not_applicable|completed_no_changes|pipeline)/i.test(artifactContent);

    if (!hasSummaryValues || !hasReferences || !hasPipelineConclusion) {
      throw new Error('Demo report does not satisfy required checks, baseline values, or sections');
    }
  }
  const observedHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: config.project,
    encoding: 'utf8',
  }).trim();
  if (observedHead !== run.epicClosure.head)
    throw new Error('Integrated revision changed before report publication');
  const report = await writeResearchReport(
    coordinator,
    {
      objective: run.subject.body,
      acceptedVersions: { integrated: run.epicClosure.head },
      observedVersions: { integrated: dispatch.inputRevision },
      pipeline: run.pipeline,
      closureEvidence: run.epicClosure.evidence,
    },
    async (brief) => {
      const candidate = brief.match(/candidate report (.*?); do not/)![1];
      writeFileSync(candidate, readFileSync(result.artifact));
      return receipt.evidence.map((e) => e.path);
    },
  );
  updateRunRegistry(config, (registry) => {
    const current = authorize(registry, runId, authority);
    if (registry.revision !== snapshot.revision)
      throw new Error('Registry changed during report publication');
    current.report = report;
    current.phase = 'completed';
    current.lifecycle = 'completed';
    if (current.constraints?.kind === 'demo') {
      const roundRoot = dirname(config.project);
      const controlFile = join(roundRoot, 'control.json');
      if (existsSync(controlFile)) {
        const control = JSON.parse(readFileSync(controlFile, 'utf8'));
        control.completed = true;
        writeFileSync(controlFile, JSON.stringify(control, null, 2));
      }
    }
  });
  return report;
}

function verifyRetainedStageEvidence(receipt: StageReceipt) {
  if (
    !receipt.evidence.length ||
    receipt.evidence.some(
      (e) => createHash('sha256').update(readFileSync(e.path)).digest('hex') !== e.hash,
    )
  )
    throw new Error('Accepted stage evidence changed');
}

/** Stable, narrow public view of Run identity, attempts, helpers, execution state, and resource ownership. */
export interface WorkflowRunView {
  id: string;
  provider: string;
  lifecycle: WorkflowRun['lifecycle'];
  phase?: WorkflowRun['phase'];
  constraints?: RunConstraints;
  subject: RunSubject;
  orchestratorId: string;
  orchestrator?: ManagedAttempt;
  priorOrchestrators?: ManagedAttempt[];
  attempts: ManagedAttempt[];
  dispatches: StageDispatch[];
  receipts: NonNullable<RunRegistry['receipts']>;
  deliveries: NonNullable<RunRegistry['deliveries']>;
  pullRequests: NonNullable<RunRegistry['pullRequests']>;
  resources: NonNullable<RunRegistry['resources']>;
  helper: {
    active: boolean;
    pending?: boolean;
    evidenceDirectory?: string;
    error?: string;
  };
  reconciliation?: WorkflowRun['reconciliation'];
  execution: 'running' | 'reserved' | 'blocked' | 'completed' | 'unknown' | 'terminated';
  terminated: boolean;
  released: boolean;
  epicClosure?: WorkflowRun['epicClosure'];
  pipeline?: PipelineDisposition;
  report?: import('../delivery/research-report.js').ResearchReport;
}

/** Result of a verified stopRun operation. */
export interface StopRunResult {
  runId: string;
  lifecycle: WorkflowRun['lifecycle'];
  terminated: boolean;
  released: boolean;
  attempts: {
    id: string;
    role: ManagedAttempt['role'];
    status: ManagedAttempt['status'];
    terminated: boolean;
    cancellation?: AttemptControl['cancellation'];
    error?: string;
  }[];
  helper: {
    active: boolean;
    pending?: boolean;
    stopped: boolean;
  };
  resources: { path: string; runId: string }[];
  blockers: string[];
}

/** Result of a completed releaseRun operation. */
export interface ReleaseRunResult {
  runId: string;
  lifecycle: WorkflowRun['lifecycle'];
  terminated: boolean;
  released: boolean;
  attempts: {
    id: string;
    role: ManagedAttempt['role'];
    status: ManagedAttempt['status'];
    terminated: boolean;
    cancellation?: AttemptControl['cancellation'];
    error?: string;
  }[];
  helper: {
    active: boolean;
    pending?: boolean;
    stopped: boolean;
  };
  resources: { path: string; runId: string }[];
  blockers: string[];
}

/** Read a stable, narrow public view of a single Run and its owned resources without exposing registry serialization. */
export function inspectRun(config: FleetConfig, runId: string): WorkflowRunView {
  if (!runId || !/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error('Expected a valid Run id');
  const registry = inspectRuns(config);
  const run = registry.runs.find((r) => r.id === runId);
  if (!run) throw new Error(`Unknown Run: expected existing run with id ${runId}`);

  const dispatches = (registry.dispatches ?? []).filter((d) => d.runId === run.id);
  const receipts = (registry.receipts ?? []).filter((r) => r.runId === run.id);
  const attempts = [
    ...(run.priorOrchestrators ?? []),
    ...(run.orchestrator ? [run.orchestrator] : []),
    ...dispatches.flatMap((d) => d.attempts),
  ];
  const resources = (registry.resources ?? []).filter((r) => r.runId === run.id);
  const deliveries = (registry.deliveries ?? []).filter((d) => d.runId === run.id);
  const pullRequests = (registry.pullRequests ?? []).filter((p) => p.runId === run.id);
  const helper = startupRecoveryStatus(config, run.id, registry);

  const isAttemptTerminated = (a: ManagedAttempt): boolean => {
    const control = inspectAttemptControl(a);
    return (
      control.execution?.status === 'terminated' ||
      (a.startupStopped === true && a.status !== 'running' && !a.address)
    );
  };

  const terminated = attempts.length > 0 && attempts.every(isAttemptTerminated);
  const released =
    (attempts.length === 0 || attempts.every(isAttemptTerminated)) &&
    !helper.active &&
    resources.length === 0;

  let execution: WorkflowRunView['execution'];
  if (
    attempts.some(
      (a) => a.status === 'running' || inspectAttemptControl(a).execution?.status === 'running',
    )
  ) {
    execution = 'running';
  } else if (
    attempts.some(
      (a) => a.status === 'unknown' || inspectAttemptControl(a).execution?.status === 'unknown',
    )
  ) {
    execution = 'unknown';
  } else if (terminated) {
    execution = 'terminated';
  } else if (run.lifecycle === 'completed') {
    execution = 'completed';
  } else {
    execution = run.lifecycle;
  }

  return {
    id: run.id,
    provider: run.provider,
    lifecycle: run.lifecycle,
    phase: run.phase,
    constraints: run.constraints,
    subject: run.subject,
    orchestratorId: run.orchestratorId,
    orchestrator: run.orchestrator,
    priorOrchestrators: run.priorOrchestrators,
    attempts,
    dispatches,
    receipts,
    deliveries,
    pullRequests,
    resources,
    helper,
    reconciliation: run.reconciliation,
    execution,
    terminated,
    released,
    epicClosure: run.epicClosure,
    pipeline: run.pipeline,
    report: run.report,
  };
}

/** Read narrow public views of all registered Runs. */
export function inspectRunViews(config: FleetConfig): WorkflowRunView[] {
  const registry = inspectRuns(config);
  return registry.runs.map((r) => inspectRun(config, r.id));
}

async function terminateAndVerifyAttempt(
  config: FleetConfig,
  adapter: RunnerAdapter,
  runId: string,
  attempt: ManagedAttempt,
  options?: { stopped?: (attempt: ManagedAttempt) => Promise<boolean> },
): Promise<{
  result: StopRunResult['attempts'][number];
  blocker?: string;
}> {
  let term: ExecutionTermination;
  if (options?.stopped) {
    const alreadyStopped = await options.stopped(attempt);
    if (alreadyStopped) {
      term = { status: 'terminated', evidence: 'Verified stopped by predicate' };
    } else {
      term = await terminateAttempt(attempt, adapter);
      if (term.status === 'terminated' && !(await options.stopped(attempt))) {
        term = { status: 'unconfirmed', error: 'Termination unverified by stopped predicate' };
      }
    }
  } else {
    term = await terminateAttempt(attempt, adapter);
  }

  const stopped = term.status === 'terminated';
  const cancellationControl = inspectAttemptControl(attempt).cancellation;
  const error = term.error;
  let blocker: string | undefined;

  if (stopped) {
    await reconcileAttempt(attempt, { termination: async () => true, stopped: async () => true });
    updateRunRegistry(config, (registry) => {
      const r = registry.runs.find((entry) => entry.id === runId);
      if (!r) return;
      const all = [
        ...(r.priorOrchestrators ?? []),
        ...(r.orchestrator ? [r.orchestrator] : []),
        ...(registry.dispatches?.filter((d) => d.runId === runId).flatMap((d) => d.attempts) ?? []),
      ];
      const match = all.find((a) => a.id === attempt.id);
      if (match) {
        match.status = 'unknown';
        match.startupStopped = true;
      }
    });
  } else {
    const ctrl = inspectAttemptControl(attempt);
    ctrl.execution = { status: 'unknown' };
    writeFileSync(join(attempt.directory, 'control.json'), JSON.stringify(ctrl));
    blocker = `Attempt ${attempt.id} (${attempt.role}) termination unverified; occupancy remains reserved`;
  }

  return {
    result: {
      id: attempt.id,
      role: attempt.role,
      status: stopped ? 'unknown' : attempt.status,
      terminated: stopped,
      cancellation: cancellationControl,
      error,
    },
    blocker,
  };
}

/** Revoke scheduling and activation before terminating owned executions and helpers, preserving business records. */
export async function stopRun(
  config: FleetConfig,
  runner: RunnerAdapter,
  runId: string,
  options?: {
    stopped?: (attempt: ManagedAttempt) => Promise<boolean>;
    cleanup?: () => void;
  },
): Promise<StopRunResult> {
  const opts = options ?? {};

  if (!runId || !/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error('Expected a valid Run id');

  const snapshot = inspectRuns(config);
  const targetRun = snapshot.runs.find((r) => r.id === runId);
  if (!targetRun) throw new Error(`Unknown Run: expected existing run with id ${runId}`);

  if (runner.name !== targetRun.provider)
    throw new Error(
      `Run provider mismatch: expected provider ${targetRun.provider}, but received ${runner.name}`,
    );

  const adapter = runner;

  // Revoke further scheduling and activation before requesting cancellation
  updateRunRegistry(config, (registry) => {
    const current = registry.runs.find((r) => r.id === runId);
    if (!current) throw new Error(`Unknown Run: expected existing run with id ${runId}`);
    if (current.lifecycle !== 'completed') {
      current.lifecycle = 'blocked';
    }
    if (current.orchestrator && current.orchestrator.status !== 'running') {
      current.orchestrator.startupStopped = true;
    }
    for (const dispatch of registry.dispatches?.filter((d) => d.runId === runId) ?? []) {
      for (const attempt of dispatch.attempts) {
        if (attempt.status !== 'running') {
          attempt.startupStopped = true;
        }
      }
    }
  });

  // Stop startup helper
  const helperStopped = await stopStartupRecovery(config, runId);
  const helperStatus = startupRecoveryStatus(config, runId);
  const blockers: string[] = [];
  if (helperStatus.active) {
    blockers.push('Startup helper termination unverified; helper remains active');
  }

  const isStopped =
    opts.stopped ??
    (adapter.stopped
      ? (a: ManagedAttempt) => adapter.stopped!(a)
      : async (a: ManagedAttempt) => (await terminateAttempt(a, adapter)).status === 'terminated');

  const currentSnapshot = inspectRuns(config);
  const currentRun = currentSnapshot.runs.find((r) => r.id === runId)!;
  const attempts = [
    ...(currentRun.priorOrchestrators ?? []),
    ...(currentRun.orchestrator ? [currentRun.orchestrator] : []),
    ...(currentSnapshot.dispatches?.filter((d) => d.runId === runId).flatMap((d) => d.attempts) ?? []),
  ];

  const attemptResults: StopRunResult['attempts'] = [];

  for (const attempt of attempts) {
    const { result, blocker } = await terminateAndVerifyAttempt(
      config,
      adapter,
      runId,
      attempt,
      opts,
    );
    if (blocker) {
      blockers.push(blocker);
    }
    attemptResults.push(result);
  }

  // Release checkouts only if explicit cleanup callback is provided
  if (opts.cleanup) {
    const reg = inspectRuns(config);
    const owned = (reg.resources ?? []).filter((r) => r.runId === runId);
    for (const res of owned) {
      try {
        await releaseRunCheckout(config, runId, res.path, isStopped, opts.cleanup);
      } catch (err) {
        blockers.push(`Resource ${res.path} release failed: ${String(err)}`);
      }
    }
  }

  const finalReg = inspectRuns(config);
  const finalRun = finalReg.runs.find((r) => r.id === runId)!;
  const finalResources = (finalReg.resources ?? []).filter((r) => r.runId === runId);
  const finalHelper = startupRecoveryStatus(config, runId);

  const allTerminated =
    attemptResults.length === 0 || attemptResults.every((a) => a.terminated);
  const released =
    allTerminated && !finalHelper.active && finalResources.length === 0;

  updateRunRegistry(config, (registry) => {
    const r = registry.runs.find((entry) => entry.id === runId);
    if (r) {
      r.reconciliation = {
        at: new Date().toISOString(),
        blockers,
        pendingDispatches: r.reconciliation?.pendingDispatches ?? [],
      };
    }
  });

  return {
    runId,
    lifecycle: finalRun.lifecycle,
    terminated: allTerminated,
    released,
    attempts: attemptResults,
    helper: {
      active: finalHelper.active,
      pending: finalHelper.pending,
      stopped: helperStopped,
    },
    resources: finalResources,
    blockers,
  };
}

/** Terminate remaining executions and helpers for a completed Run without changing business success into failure. */
export async function releaseRun(
  config: FleetConfig,
  runner: RunnerAdapter,
  runId: string,
  options?: {
    stopped?: (attempt: ManagedAttempt) => Promise<boolean>;
    cleanup?: () => void;
  },
): Promise<ReleaseRunResult> {
  const opts = options ?? {};

  if (!runId || !/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error('Expected a valid Run id');

  const snapshot = inspectRuns(config);
  const targetRun = snapshot.runs.find((r) => r.id === runId);
  if (!targetRun) throw new Error(`Unknown Run: expected existing run with id ${runId}`);

  if (targetRun.lifecycle !== 'completed') {
    throw new Error(
      `Run ${runId} is not completed (lifecycle: ${targetRun.lifecycle}); only completed Runs can be released with releaseRun`,
    );
  }

  if (runner.name !== targetRun.provider)
    throw new Error(
      `Run provider mismatch: expected provider ${targetRun.provider}, but received ${runner.name}`,
    );

  const adapter = runner;

  // Stop startup helper
  const helperStopped = await stopStartupRecovery(config, runId);
  const helperStatus = startupRecoveryStatus(config, runId);
  const blockers: string[] = [];
  if (helperStatus.active) {
    blockers.push('Startup helper termination unverified; helper remains active');
  }

  const isStopped =
    opts.stopped ??
    (adapter.stopped
      ? (a: ManagedAttempt) => adapter.stopped!(a)
      : async (a: ManagedAttempt) => (await terminateAttempt(a, adapter)).status === 'terminated');

  const attempts = [
    ...(targetRun.priorOrchestrators ?? []),
    ...(targetRun.orchestrator ? [targetRun.orchestrator] : []),
    ...(snapshot.dispatches?.filter((d) => d.runId === runId).flatMap((d) => d.attempts) ?? []),
  ];

  const attemptResults: ReleaseRunResult['attempts'] = [];

  for (const attempt of attempts) {
    const { result, blocker } = await terminateAndVerifyAttempt(
      config,
      adapter,
      runId,
      attempt,
      opts,
    );
    if (blocker) {
      blockers.push(blocker);
    }
    attemptResults.push(result);
  }

  // Release checkouts only if explicit cleanup callback is provided
  const regBeforeCleanup = inspectRuns(config);
  const ownedResources = (regBeforeCleanup.resources ?? []).filter((r) => r.runId === runId);
  if (ownedResources.length > 0) {
    if (opts.cleanup) {
      for (const res of ownedResources) {
        try {
          await releaseRunCheckout(config, runId, res.path, isStopped, opts.cleanup);
        } catch (err) {
          blockers.push(`Resource ${res.path} release failed: ${String(err)}`);
        }
      }
    } else {
      blockers.push('Checkout release requires the workflow preservation and cleanup gate');
    }
  }

  const finalReg = inspectRuns(config);
  const finalRun = finalReg.runs.find((r) => r.id === runId)!;
  const finalResources = (finalReg.resources ?? []).filter((r) => r.runId === runId);
  const finalHelper = startupRecoveryStatus(config, runId);

  const allTerminated =
    attemptResults.length === 0 || attemptResults.every((a) => a.terminated);
  const released =
    allTerminated && !finalHelper.active && finalResources.length === 0;

  updateRunRegistry(config, (registry) => {
    const r = registry.runs.find((entry) => entry.id === runId);
    if (r) {
      r.reconciliation = {
        at: new Date().toISOString(),
        blockers,
        pendingDispatches: r.reconciliation?.pendingDispatches ?? [],
      };
    }
  });

  return {
    runId,
    lifecycle: finalRun.lifecycle,
    terminated: allTerminated,
    released,
    attempts: attemptResults,
    helper: {
      active: finalHelper.active,
      pending: finalHelper.pending,
      stopped: helperStopped,
    },
    resources: finalResources,
    blockers,
  };
}

