/** Run intake and authoritative Fleet relationships; managed execution belongs to one Run. */
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { claimDriver } from './driver-lock.js';
import { stateDirectory } from './handoff.js';
import { workflowSource, type FleetConfig } from './fleet-config.js';
import {
  inspectOrchestrator,
  requireInteractive,
  cancelAttempt,
  startOrchestrator,
  type ManagedAttempt,
  type RunnerAdapter,
} from './runtime.js';
import { pipelineAccepted, type PipelineDisposition } from './epic-finalization.js';
import type { IssueInput } from './issue-driver.js';

/** Verified tracker subject, with explicit scope rather than title heuristics. */
export interface RunSubject extends IssueInput {
  kind: 'issue' | 'epic';
}
/** One requested workflow with a fixed provider and dedicated execution identity. */
export interface WorkflowRun {
  id: string;
  subject: RunSubject;
  provider: string;
  policy: { name: string; revision: number };
  lifecycle: 'reserved' | 'running' | 'blocked' | 'completed';
  phase?: 'post_closure_finalization' | 'completed';
  pipeline?: PipelineDisposition;
  pipelineApprovals?: Record<string, { source: 'human'; ledger: string; evidence: string }>;
  pipelineMaintenance?: import('./epic-finalization.js').EpicFinalization['maintenanceDeliveries'];
  report?: import('./research-report.js').ResearchReport;
  epicClosure?: { deliveryVersion: string; head: string; evidence: string; confirmed: string };
  orchestratorId: string;
  launchStarted?: boolean;
  orchestrator?: ManagedAttempt;
  brief: { path: string; hash: string };
  reconciliation?: { at: string; blockers: string[]; pendingDispatches: string[] };
  priorOrchestrators?: ManagedAttempt[];
}
/** Atomic Fleet relationship snapshot. */
export interface RunRegistry {
  deliveries?: {
    runId: string;
    repository: string;
    issue: number;
    pr: number;
    status: string;
    recorded?: boolean;
    archive?: string;
    released?: boolean;
    evidence: string;
    dispatches: string[];
  }[];
  pullRequests?: {
    runId: string;
    repository: string;
    issue: number;
    pr: number;
    evidence: string;
    status: string;
    checkedHead?: string;
    mergeCommit?: string;
    dispatches: string[];
    error?: string;
  }[];
  revision: number;
  runs: WorkflowRun[];
  dispatches?: StageDispatch[];
  receipts?: StageReceipt[];
  resources?: { path: string; runId: string; registry: string }[];
  subjects?: { subject: string; ownerRunId: string; consumingRunIds: string[] }[];
  stageEvents?: { receiptId: string; kind: 'reported' }[];
  acknowledgements?: {
    id: string;
    receiptId: string;
    accepted: boolean;
    evidence: string;
    reason?: string;
  }[];
}
function home(config: FleetConfig): string {
  return stateDirectory(config, '.runtime', createHash('sha256').update(config.file).digest('hex'));
}
/** Read only; absent legacy Run identities are never fabricated. */
export function inspectRuns(config: FleetConfig): RunRegistry {
  const file = join(home(config), 'registry.json');
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as RunRegistry)
    : { revision: 0, runs: [] };
}
function save(config: FleetConfig, registry: RunRegistry): void {
  const file = join(home(config), 'registry.json');
  const temp = file + '.' + randomUUID();
  registry.revision++;
  writeFileSync(temp, JSON.stringify(registry, null, 2), { mode: 0o600 });
  renameSync(temp, file);
}
/** Reserve before managed launch; initial bounded path preserves Fleet-wide exclusion. */
export async function startRun(
  config: FleetConfig,
  runner: RunnerAdapter,
  subject: RunSubject,
  provider: string,
): Promise<WorkflowRun> {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(subject.repository) ||
    !Number.isSafeInteger(subject.number) ||
    subject.number < 1
  )
    throw new Error(
      'Resolve an accessible repository owner/name and positive Issue number before launch',
    );
  if (!['codex', 'agy', 'claude'].includes(provider) || runner.name !== provider)
    throw new Error(
      'Managed provider must be codex, agy, or claude and match the selected adapter',
    );
  requireInteractive(runner);
  await runner.preflight();
  const reconnect = inspectRuns(config).runs.find(
    (r) =>
      r.subject.repository === subject.repository &&
      r.subject.number === subject.number &&
      r.lifecycle !== 'completed',
  );
  if (reconnect) {
    if (reconnect.provider !== provider || reconnect.subject.kind !== subject.kind)
      throw new Error('Existing Run provider or scope conflict');
    await recoverRun(config, runner, reconnect.id);
    return inspectRuns(config).runs.find((r) => r.id === reconnect.id)!;
  }
  mkdirSync(home(config), { recursive: true });
  const lock = join(home(config), 'registry.lock');
  try {
    claimDriver(lock);
  } catch {
    throw new Error('Registry occupied; inspect before retry');
  }
  try {
    const registry = inspectRuns(config);
    const ownership = registry.subjects?.find(
      (s) => s.subject === `${subject.repository}#${subject.number}`,
    );
    const owningRun = registry.runs.find((r) => r.id === ownership?.ownerRunId);
    if (owningRun && owningRun.subject.number !== subject.number) {
      if (owningRun.provider !== provider)
        throw new Error('Existing child execution provider conflict');
      return owningRun;
    }
    if (subject.parent && !subject.blockedBy)
      throw new Error('Child dependencies unresolved; refresh tracker metadata');
    if (subject.blockedBy?.length)
      throw new Error(`Unmet dependencies: ${subject.blockedBy.join(', ')}`);

    const existing = registry.runs.find(
      (r) =>
        r.subject.repository === subject.repository &&
        r.subject.number === subject.number &&
        r.lifecycle !== 'completed',
    );
    if (existing) {
      if (existing.provider !== provider || existing.subject.kind !== subject.kind)
        throw new Error('Existing Run provider or scope conflict');
      return existing;
    }
    const id = randomUUID();
    const directory = join(home(config), 'runs', id);
    mkdirSync(directory, { recursive: true });
    const brief = `Manage only ${subject.kind} ${subject.repository}#${subject.number}. Run ${id}. Provider ${provider}.\n${subject.parent ? `Parent context #${subject.parent}; no sibling or parent closure authorization.\n` : ''}${subject.title}\n${subject.body}`;
    const path = join(directory, 'brief.md');
    writeFileSync(path, brief, { mode: 0o400, flag: 'wx' });
    const run: WorkflowRun = {
      id,
      subject,
      provider,
      policy: { name: 'managed-run', revision: 1 },
      lifecycle: 'reserved',
      orchestratorId: id,
      launchStarted: false,
      brief: { path, hash: createHash('sha256').update(brief).digest('hex') },
    };
    registry.runs.push(run);
    reserveSubject(registry, run.id, `${subject.repository}#${subject.number}`);
    save(config, registry);
    // The durable reservation survives a crash or failed launch and blocks replacement.
    try {
      run.launchStarted = true;
      save(config, registry);
      run.orchestrator = await startOrchestrator(config, runner, brief, id);
      run.lifecycle = run.orchestrator.status === 'running' ? 'running' : 'blocked';
    } catch (error) {
      run.lifecycle = 'blocked';
      save(config, registry);
      throw error;
    }
    save(config, registry);
    return run;
  } finally {
    rmSync(lock, { recursive: true });
  }
}

/** Immutable stage request; only the owning Orchestrator requests top-level work. */
export interface StageRequest {
  runId: string;
  authority: string;
  subject: string;
  role: ManagedAttempt['role'];
  stage: string;
  inputRevision: string;
  brief: string;
  prerequisites: string[];
  terminalSession?: string;
  writableDirectories?: string[];
  checkout?: string;
}
/** A generation groups retries of unchanged immutable inputs. */
export interface StageDispatch extends StageRequest {
  id: string;
  generation: number;
  provider: string;
  briefReference: { path: string; hash: string };
  attempts: ManagedAttempt[];
  lifecycle: 'reserved' | 'running' | 'reported' | 'accepted' | 'rejected' | 'superseded';
  acceptedReceipt?: string;
  messages?: {
    id: string;
    brief: string;
    status: 'pending' | 'delivered' | 'uncertain';
    evidence?: string;
  }[];
  remediation?: { consecutive: number; limit: number; feedback: string; exhausted: boolean };
}
/** A claim is immutable; acceptance is a separate durable acknowledgement. */
export interface StageReceipt {
  id: string;
  dispatchId: string;
  attemptId: string;
  runId: string;
  subject: string;
  role: ManagedAttempt['role'];
  stage: string;
  provider: string;
  inputRevision: string;
  outcome: 'completed' | 'changes_needed' | 'blocked';
  evidence: { path: string; hash: string }[];
  corrects?: string;
}
/** Mechanical verification supplied by the workflow's current-fact adapter. */
export interface StageFacts {
  currentRevision: string;
  ownership: boolean;
  evidence: string;
}
/** Atomically mutate relationship state; unknown locks remain occupied. */
export function updateRunRegistry<T>(config: FleetConfig, change: (registry: RunRegistry) => T): T {
  mkdirSync(home(config), { recursive: true });
  const lock = join(home(config), 'registry.lock');
  try {
    claimDriver(lock);
  } catch {
    throw new Error('Registry occupied; inspect before retry');
  }
  try {
    const registry = inspectRuns(config);
    const result = change(registry);
    save(config, registry);
    return result;
  } finally {
    rmSync(lock, { recursive: true });
  }
}
function findDispatch(registry: RunRegistry, id: string): StageDispatch {
  const dispatch = registry.dispatches?.find((d) => d.id === id);
  if (!dispatch) throw new Error('Unknown Dispatch');
  return dispatch;
}
function authorize(registry: RunRegistry, runId: string, authority: string): WorkflowRun {
  const run = registry.runs.find((r) => r.id === runId);
  if (!run || run.orchestratorId !== authority || run.lifecycle !== 'running')
    throw new Error('Inactive or wrong Orchestrator authority');
  return run;
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
    if (
      !(await (
        runner as RunnerAdapter & { stopped?(a: ManagedAttempt): Promise<boolean> }
      ).stopped?.(attempt))
    )
      throw new Error(
        'Prior execution termination unverified; prerequisite occupancy remains reserved',
      );
  }
  let launch = false;
  const dispatch = updateRunRegistry(config, (registry) => {
    if (registry.revision !== snapshot.revision)
      throw new Error('Execution ownership changed during termination verification; retry');
    const run = authorize(registry, request.runId, request.authority);
    if (runner.name !== run.provider) throw new Error('Run provider mismatch');
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
    if (request.role === 'pipeline-audit' && !run.epicClosure)
      throw new Error('Pipeline requires verified EPIC closure');
    if (
      request.role === 'research-state' &&
      (!run.epicClosure || !run.pipeline || !pipelineAccepted(run.pipeline))
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
      brief: request.brief,
      status: 'starting',
      created: new Date().toISOString(),
      directory,
      checkout,
      terminalSession: request.terminalSession,
      writableDirectories: request.writableDirectories,
    };
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
  if (!launch) return dispatch;
  const attempt = dispatch.attempts[0];
  attempt.dispatchId = dispatch.id;
  try {
    const ack = await runner.start(attempt);
    if (!ack.conversation || !ack.address || !ack.evidence)
      throw new Error('Missing startup acknowledgement');
    Object.assign(attempt, ack, { status: 'running' });
  } catch (error) {
    attempt.status = 'unknown';
    attempt.error = String(error);
  }
  return updateRunRegistry(config, (registry) => {
    const current = findDispatch(registry, dispatch.id);
    current.attempts[0] = attempt;
    current.lifecycle = attempt.status === 'running' ? 'running' : 'reserved';
    return current;
  });
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
): Promise<void> {
  const snapshot = inspectRuns(config);
  const receipt = snapshot.receipts?.find((r) => r.id === receiptId);
  if (!receipt) throw new Error('Unknown Receipt');
  const dispatch = findDispatch(snapshot, receipt.dispatchId);
  authorize(snapshot, dispatch.runId, authority);
  if (dispatch.acceptedReceipt === receiptId) return;
  const facts = await verify(dispatch, receipt);
  let rejection: string | undefined;
  updateRunRegistry(config, (registry) => {
    const current = findDispatch(registry, dispatch.id);
    authorize(registry, current.runId, authority);
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
      !!current.acceptedReceipt ||
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
      current.acceptedReceipt = receiptId;
      current.lifecycle = 'accepted';
      if (current.remediation) {
        current.remediation.consecutive = 0;
        current.remediation.exhausted = false;
      }
    } else if (current.lifecycle !== 'accepted' && current.lifecycle !== 'superseded')
      current.lifecycle = 'rejected';
  });
  if (rejection) throw new Error(rejection);
}

/** Retry unchanged inputs only after independently verified termination; retain every Attempt. */
export async function retryStage(
  config: FleetConfig,
  runner: RunnerAdapter,
  dispatchId: string,
  authority: string,
  stopped: (attempt: ManagedAttempt) => Promise<boolean>,
): Promise<StageDispatch> {
  const snapshot = inspectRuns(config);
  const dispatch = findDispatch(snapshot, dispatchId);
  const run = authorize(snapshot, dispatch.runId, authority);
  if (runner.name !== run.provider) throw new Error('Run provider mismatch');
  requireInteractive(runner);
  await runner.preflight();
  if (dispatch.remediation?.exhausted)
    throw new Error('Remediation exhausted: ' + dispatch.remediation.feedback);
  const prior = dispatch.attempts.at(-1)!;
  if (!(await stopped(prior))) throw new Error('Prior Attempt occupancy unresolved');
  const attempt = updateRunRegistry(config, (registry) => {
    const current = findDispatch(registry, dispatchId);
    authorize(registry, dispatch.runId, authority);
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
      id,
      directory,
      status: 'starting',
      created: new Date().toISOString(),
      conversation: undefined,
      address: undefined,
      evidence: undefined,
      error: undefined,
    };
    current.attempts.push(next);
    current.lifecycle = 'reserved';
    return next;
  });
  try {
    const ack = await runner.start(attempt);
    if (!ack.conversation || !ack.address || !ack.evidence)
      throw new Error('Missing startup acknowledgement');
    Object.assign(attempt, ack, { status: 'running' });
  } catch (error) {
    attempt.status = 'unknown';
    attempt.error = String(error);
  }
  return updateRunRegistry(config, (registry) => {
    const current = findDispatch(registry, dispatchId);
    current.attempts[current.attempts.length - 1] = attempt;
    current.lifecycle = attempt.status === 'running' ? 'running' : 'reserved';
    return current;
  });
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

/** Re-entry recovers durable claims and startup evidence; missing notifications never rerun work.
 * Replacement is opt-in and requires independently verified termination, never a timeout.
 */
export async function recoverRun(
  config: FleetConfig,
  runner: RunnerAdapter,
  runId: string,
  options: {
    stopped?: (attempt: ManagedAttempt) => Promise<boolean>;
    replaceOrchestrator?: boolean;
    /** Explicit reassignment when the old conversation cannot be recovered. */
    newConversation?: boolean;
  } = {},
): Promise<{ blockers: string[]; pendingDispatches: string[] }> {
  requireInteractive(runner);
  if (!runId || !/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error('Expected a valid Run id');
  const snapshot = inspectRuns(config);
  const run = snapshot.runs.find((r) => r.id === runId);
  if (!run || run.provider !== runner.name) throw new Error('Unknown Run or provider conflict');
  if (run.launchStarted === false && !run.orchestrator && !inspectOrchestrator(config, runId)) {
    updateRunRegistry(config, (registry) => {
      if (registry.revision !== snapshot.revision)
        throw new Error('Recovery inputs changed; retry');
      registry.runs.find((r) => r.id === runId)!.launchStarted = true;
    });
    const attempt = await startOrchestrator(
      config,
      runner,
      readFileSync(run.brief.path, 'utf8'),
      runId,
    );
    updateRunRegistry(config, (registry) => {
      const current = registry.runs.find((r) => r.id === runId)!;
      current.orchestrator = attempt;
      current.lifecycle = attempt.status === 'running' ? 'running' : 'blocked';
    });
    return recoverRun(config, runner, runId);
  }
  const blockers: string[] = [];
  const pendingDispatches: string[] = [];
  const recovered = new Map<
    string,
    Awaited<ReturnType<NonNullable<RunnerAdapter['recoverReceipt']>>>
  >();
  const orchestrator = run.orchestrator ?? inspectOrchestrator(config, runId);
  const attempts =
    snapshot.dispatches?.filter((d) => d.runId === runId).flatMap((d) => d.attempts.slice(-1)) ??
    [];
  for (const attempt of [...(orchestrator?.run === runId ? [orchestrator] : []), ...attempts]) {
    if (runner.observe) attempt.observation = await runner.observe(attempt);
    if (attempt.status !== 'running' && runner.recoverReceipt) {
      const ack = await runner.recoverReceipt(attempt);
      if (ack?.conversation && ack.address && ack.evidence) recovered.set(attempt.id, ack);
    }
  }
  let replacement: ManagedAttempt | undefined;
  if (options.replaceOrchestrator) {
    if (
      !orchestrator ||
      orchestrator.run !== runId ||
      !options.stopped ||
      !(await options.stopped(orchestrator))
    ) {
      blockers.push('Orchestrator occupancy unresolved; verify termination before replacement');
    } else {
      const id = randomUUID();
      const directory = join(home(config), 'runs', runId, id);
      mkdirSync(directory);
      replacement = {
        ...orchestrator,
        predecessor: orchestrator.id,
        id,
        directory,
        status: 'starting',
        created: new Date().toISOString(),
        conversation: options.newConversation ? undefined : orchestrator.conversation,
        brief: `Reconcile durable Run ${runId} evidence before continuing. Scope reference: ${run.brief.path}. Do not replay the original brief or repeat accepted work.`,
        address: undefined,
        evidence: undefined,
      };
    }
  }
  updateRunRegistry(config, (registry) => {
    if (registry.revision !== snapshot.revision) throw new Error('Recovery inputs changed; retry');
    const current = registry.runs.find((r) => r.id === runId)!;
    if (orchestrator?.run === runId) {
      current.orchestrator = orchestrator;
      const ack = recovered.get(orchestrator.id);
      if (ack) Object.assign(current.orchestrator, ack, { status: 'running' });
    }
    if (replacement) {
      (current.priorOrchestrators ??= []).push(orchestrator!);
      current.orchestrator = replacement;
      current.orchestratorId = replacement.id; // revoke old mutation authority before launch
      current.lifecycle = 'blocked';
    } else if (current.orchestrator?.status === 'running') current.lifecycle = 'running';
    else blockers.push('Orchestrator startup pending; unknown occupancy remains reserved');
    for (const dispatch of registry.dispatches?.filter((d) => d.runId === runId) ?? []) {
      // Immutable files precede registry/event publication, so scan them on normal re-entry.
      const directory = join(home(config), 'dispatches', dispatch.id);
      for (const file of readdirSync(directory).filter((f) => f.endsWith('.json'))) {
        const claim = JSON.parse(readFileSync(join(directory, file), 'utf8')) as StageReceipt;
        if (
          claim.dispatchId !== dispatch.id ||
          file !== claim.id + '.json' ||
          !dispatch.attempts.some((a) => a.id === claim.attemptId)
        )
          continue;
        if (!registry.receipts?.some((r) => r.id === claim.id))
          (registry.receipts ??= []).push(claim);
      }
      for (const receipt of registry.receipts?.filter((r) => r.dispatchId === dispatch.id) ?? []) {
        if (!registry.stageEvents?.some((e) => e.receiptId === receipt.id))
          (registry.stageEvents ??= []).push({ receiptId: receipt.id, kind: 'reported' });
      }
      if (
        dispatch.lifecycle === 'reserved' &&
        registry.receipts?.some((r) => r.dispatchId === dispatch.id)
      )
        dispatch.lifecycle = 'reported';
      const accepted = registry.acknowledgements?.find(
        (a) =>
          a.accepted &&
          registry.receipts?.some((r) => r.id === a.receiptId && r.dispatchId === dispatch.id),
      );
      if (accepted && dispatch.lifecycle !== 'superseded') {
        dispatch.acceptedReceipt = accepted.receiptId;
        dispatch.lifecycle = 'accepted';
      }
      const attempt = dispatch.attempts.at(-1)!;
      const observation = attempts.find((a) => a.id === attempt.id)?.observation;
      if (observation) attempt.observation = observation;
      const ack = recovered.get(attempt.id);
      if (ack) Object.assign(attempt, ack, { status: 'running' });
      if (dispatch.lifecycle === 'accepted') pendingDispatches.push(dispatch.id);
      else if (dispatch.remediation?.exhausted)
        blockers.push(`${dispatch.id}: remediation exhausted: ${dispatch.remediation.feedback}`);
      else if (attempt.status !== 'running')
        blockers.push(`${dispatch.id}: startup pending; verify occupancy before retry`);
    }
    current.reconciliation = { at: new Date().toISOString(), blockers, pendingDispatches };
  });
  if (replacement) {
    requireInteractive(runner);
    await runner.preflight();
    try {
      const ack = await runner.start(replacement);
      if (!ack.conversation || !ack.address || !ack.evidence)
        throw new Error('Missing startup acknowledgement');
      Object.assign(replacement, ack, { status: 'running' });
    } catch (error) {
      replacement.status = 'unknown';
      replacement.error = String(error);
    }
    updateRunRegistry(config, (registry) => {
      const current = registry.runs.find((r) => r.id === runId)!;
      if (current.orchestratorId !== replacement!.id) throw new Error('Recovery authority changed');
      current.orchestrator = replacement;
      current.lifecycle = replacement!.status === 'running' ? 'running' : 'blocked';
      if (replacement!.status !== 'running')
        blockers.push('Orchestrator startup pending; unknown occupancy remains reserved');
    });
  }
  return { blockers, pendingDispatches };
}

/** Reference an existing subject execution; never manufacture a second owner. */
export function reserveSubject(registry: RunRegistry, runId: string, subject: string): string {
  registry.subjects ??= [];
  const existing = registry.subjects.find((s) => s.subject === subject);
  if (existing) {
    if (existing.ownerRunId !== runId && !existing.consumingRunIds.includes(runId))
      existing.consumingRunIds.push(runId);
    if (existing.ownerRunId !== runId)
      throw new Error(`Subject owned by Run ${existing.ownerRunId}`);
    return existing.ownerRunId;
  }
  registry.subjects.push({ subject, ownerRunId: runId, consumingRunIds: [] });
  return runId;
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
  const attempts =
    snapshot.dispatches
      ?.filter((d) => d.runId === runId)
      .flatMap((d) => d.attempts)
      .filter((a) => a.checkout === physical) ?? [];
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
  const next = `pc workflow orchestrator start ${number} --provider <provider> --config ${config.file}`;
  if (!run) throw new Error(`No Run owns ${repository}#${number}; run ${next}`);
  if (!['codex', 'agy', 'claude'].includes(run.provider))
    throw new Error(`Unsupported Run provider: ${String(run.provider)}`);
  if (!run.orchestrator || run.orchestrator.status !== 'running')
    throw new Error(
      `No active Orchestrator for Run ${run.id}; run pc workflow orchestrator recover ${run.id} --config ${config.file}`,
    );
  if (run.orchestrator.runner !== run.provider)
    throw new Error(
      `Run provider mismatch: expected ${run.provider}, received ${run.orchestrator.runner}`,
    );
  return run.orchestrator;
}
/** Record a consuming Run reference without granting another execution owner. */
export function referenceRunSubject(config: FleetConfig, runId: string, subject: string): string {
  return updateRunRegistry(config, (registry) => {
    if (!registry.runs.some((r) => r.id === runId)) throw new Error('Unknown Run');
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
      `No Run owns ${repository}#${number}; run pc workflow orchestrator start ${number} --provider <provider> --config ${config.file}`,
    );
  if (owner.runner !== runner.name) throw new Error('Run provider mismatch');
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
  runner: RunnerAdapter & { collect(a: ManagedAttempt): Promise<string> },
  attempt: ManagedAttempt,
  validate?: (result: string) => void,
): Promise<string> {
  const result =
    runner.interactive && runner.result && attempt.dispatchId
      ? await runner.result(attempt, attempt.dispatchId)
      : await runner.collect(attempt);
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
      evidence: [{ path, hash: createHash('sha256').update(result).digest('hex') }],
    });
    if (!validate) return result;
    validate(result);
    await acceptStageReceipt(config, dispatch.authority, receipt.id, async () => ({
      currentRevision: dispatch.inputRevision,
      ownership: true,
      evidence: 'Collected immutable business result under reserved Run authority',
    }));
    if (runner.interactive && runner.result)
      await releaseAcceptedExecution(config, runner, dispatch.id, dispatch.authority);
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
): Promise<void> {
  if (!domainEvidence.trim()) throw new Error('Domain acceptance evidence required');
  for (const attempt of attempts) {
    const registry = inspectRuns(config);
    const dispatch = registry.dispatches?.find((d) => d.attempts.some((a) => a.id === attempt.id));
    if (!dispatch || dispatch.lifecycle === 'accepted') continue;
    const receipt = registry.receipts?.filter((r) => r.dispatchId === dispatch.id).at(-1);
    if (!receipt) throw new Error('Business completion receipt missing');
    await acceptStageReceipt(config, dispatch.authority, receipt.id, async () => ({
      currentRevision: dispatch.inputRevision,
      ownership: true,
      evidence: domainEvidence,
    }));
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
  const attempt = updateRunRegistry(config, (registry) => {
    const dispatch = findDispatch(registry, dispatchId);
    authorize(registry, dispatch.runId, authority);
    if (dispatch.provider !== runner.name) throw new Error('Run provider mismatch');
    const existing = dispatch.messages?.find((m) => m.id === message.id);
    if (existing) {
      if (existing.brief !== message.brief)
        throw new Error('Message identity already bound to different input');
    } else {
      (dispatch.messages ??= []).push({ ...message, status: 'pending' });
      send = true;
    }
    return dispatch.attempts.at(-1)!;
  });
  if (!send) return;
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

/** Stop accepted, unassigned execution before invoking the existing checkout release gate. */
export async function releaseAcceptedExecution(
  config: FleetConfig,
  runner: RunnerAdapter,
  dispatchId: string,
  authority: string,
  cleanup?: () => void,
): Promise<void> {
  const registry = inspectRuns(config);
  const dispatch = findDispatch(registry, dispatchId);
  authorize(registry, dispatch.runId, authority);
  if (runner.name !== dispatch.provider) throw new Error('Run provider mismatch');
  if (dispatch.lifecycle !== 'accepted' || dispatch.messages?.some((m) => m.status !== 'delivered'))
    throw new Error('Acceptance and reconciled input required before release');
  const attempt = dispatch.attempts.at(-1)!;
  if (!runner.stopped) throw new Error('Verified termination capability required');
  if (!(await runner.stopped(attempt))) {
    const cancellation = await cancelAttempt(attempt, runner);
    if (cancellation.cancellation?.outcome !== 'confirmed' || !(await runner.stopped(attempt)))
      throw new Error('Unknown termination; checkout remains occupied');
  }
  await releaseRunCheckout(
    config,
    dispatch.runId,
    attempt.checkout,
    runner.stopped.bind(runner),
    cleanup,
  );
}
