import { execFileSync } from 'node:child_process';
import { writeResearchReport } from '../delivery/research-report.js';
import { ensureStartupRecovery, reconcileStartup, stopStartupRecovery, startupRecoveryStatus } from './startup.js';
import { assertStageRole, assertWorkflowRole } from '../runtime/workflow-role.js';
import { initializationInstructions, verifyRoleInitialization } from './role-initialization.js';
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
import { join, dirname } from 'node:path';
import { claimDriver } from './driver-lock.js';
import { stateDirectory } from '../handoff.js';
import { workflowSource, type FleetConfig } from '../fleet/fleet-config.js';
import {
  inspectOrchestrator,
  requireInteractive,
  cancelAttempt,
  reconcileAttempt,
  inspectAttemptControl,
  managedRunner,
  startOrchestrator,
  type ManagedAttempt,
  type RunnerAdapter,
  type AttemptControl,
} from '../runtime/runtime.js';
import { pipelineAccepted, type PipelineDisposition } from '../delivery/epic-finalization.js';
import type { IssueInput } from '../delivery/issue-driver.js';

/** Verified tracker subject, with explicit scope rather than title heuristics. */
export interface RunSubject extends IssueInput {
  kind: 'issue' | 'epic';
}
/** Minimal per-Run constraint contract; fixed at intake and immutable across reconnects. */
export interface RunConstraints {
  kind: 'demo';
  roundId: string;
  demoConfigPath?: string;
  boundAt?: string;
}

/** One requested workflow with a fixed provider and dedicated execution identity. */
export interface WorkflowRun {
  id: string;
  subject: RunSubject;
  provider: string;
  /** Immutable opt-in inherited by agy attempts, retries and replacements. */
  dangerouslySkipPermissions?: boolean;
  policy: { name: string; revision: number };
  lifecycle: 'reserved' | 'running' | 'blocked' | 'completed';
  phase?: 'post_closure_finalization' | 'completed';
  constraints?: RunConstraints;
  pipeline?: PipelineDisposition;
  pipelineApprovals?: Record<string, { source: 'human'; ledger: string; evidence: string }>;
  pipelineMaintenance?: import('../delivery/epic-finalization.js').EpicFinalization['maintenanceDeliveries'];
  report?: import('../delivery/research-report.js').ResearchReport;
  epicClosure?: { deliveryVersion: string; head: string; evidence: string; confirmed: string };
  orchestratorId: string;
  launchStarted?: boolean;
  orchestrator?: ManagedAttempt;
  brief: { path: string; hash: string };
  requirements?: string;
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
    releasePrepared?: boolean;
    checkedHead?: string;
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
  const registry: RunRegistry = existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8'))
    : { revision: 0, runs: [] };
  validateRegistryRoles(registry, file);
  return registry;
}
function validateRegistryRoles(registry: RunRegistry, source: string): void {
  const checkAttempt = (attempt: ManagedAttempt, expected: ManagedAttempt['role']) => {
    assertWorkflowRole(attempt.role, `${source}: attempt ${attempt.id}`);
    if (attempt.role !== expected)
      throw new Error(
        `${source}: attempt ${attempt.id} requires workflow role ${expected}; received ${attempt.role}`,
      );
    if (attempt.initialization && attempt.initialization.role !== expected)
      throw new Error(`${source}: initialization role mismatch for ${attempt.id}`);
  };
  for (const run of registry.runs) {
    for (const attempt of [
      ...(run.priorOrchestrators ?? []),
      ...(run.orchestrator ? [run.orchestrator] : []),
    ])
      checkAttempt(attempt, 'orchestrator');
  }
  for (const dispatch of registry.dispatches ?? []) {
    assertStageRole(dispatch.stage, dispatch.role, `${source}: dispatch ${dispatch.id}`);
    for (const attempt of dispatch.attempts) checkAttempt(attempt, dispatch.role);
  }
  for (const receipt of registry.receipts ?? []) {
    assertStageRole(receipt.stage, receipt.role, `${source}: receipt ${receipt.id}`);
    const dispatch = registry.dispatches?.find((d) => d.id === receipt.dispatchId);
    if (dispatch && receipt.role !== dispatch.role)
      throw new Error(`${source}: receipt ${receipt.id} role differs from its workflow assignment`);
  }
}
function save(config: FleetConfig, registry: RunRegistry): void {
  validateRegistryRoles(registry, 'Run registry');
  const file = join(home(config), 'registry.json');
  const temp = file + '.' + randomUUID();
  registry.revision++;
  writeFileSync(temp, JSON.stringify(registry, null, 2), { mode: 0o600 });
  renameSync(temp, file);
}
/** Verify immutable Run context and additional requirements before re-entry. */
export function verifyRunRequirements(run: WorkflowRun, supplied?: string): void {
  const context = readFileSync(run.brief.path, 'utf8');
  if (createHash('sha256').update(context).digest('hex') !== run.brief.hash)
    throw new Error('Immutable Run context hash mismatch; inspect the stored context');
  if (
    run.requirements !== undefined &&
    !context.endsWith(`\n\n## Run Requirements\n\n${run.requirements}`)
  )
    throw new Error('Run Requirements do not match immutable context');
  if (supplied !== undefined && supplied !== run.requirements)
    throw new Error('Requirements conflict with immutable Run context; reuse stored Requirements');
}
function assignmentWithRequirements(run: WorkflowRun, brief: string): string {
  verifyRunRequirements(run);
  if (run.requirements === undefined) return brief;
  const prefix = `## Run Requirements\n\n${run.requirements}\n\n## Assignment\n\n`;
  return brief.startsWith(prefix) ? brief : prefix + brief;
}
/** Reserve before managed launch; initial bounded path preserves Fleet-wide exclusion. */
export async function startRun(
  config: FleetConfig,
  runner: RunnerAdapter,
  subject: RunSubject,
  provider: string,
  requirements?: string,
  dangerouslySkipPermissions?: boolean,
  constraints?: RunConstraints,
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
  if (dangerouslySkipPermissions && provider !== 'agy')
    throw new Error('--dangerously-skip-permissions requires --provider agy');
  if (!constraints && (config as unknown as { demo?: { round?: string; config?: string } }).demo?.round) {
    const demoInfo = (config as unknown as { demo: { round: string; config?: string } }).demo;
    constraints = {
      kind: 'demo',
      roundId: demoInfo.round,
      demoConfigPath: demoInfo.config,
    };
  }
  const verifyPermissions = (run: WorkflowRun) => {
    if (dangerouslySkipPermissions && !run.dangerouslySkipPermissions)
      throw new Error('Permission mode conflicts with the existing Run; reuse its stored mode');
  };
  const verifyConstraints = (run: WorkflowRun) => {
    if (run.constraints && constraints) {
      if (
        run.constraints.kind !== constraints.kind ||
        run.constraints.roundId !== constraints.roundId
      )
        throw new Error('Constraints conflict with existing Run; reuse stored constraints');
    }
  };
  requireInteractive(runner);
  await runner.preflight();
  const reconnect = inspectRuns(config).runs.find(
    (r) =>
      r.subject.repository === subject.repository &&
      r.subject.number === subject.number &&
      r.lifecycle !== 'completed',
  );

  if (reconnect) {
    verifyPermissions(reconnect);
    verifyRunRequirements(reconnect, requirements);
    verifyConstraints(reconnect);
    if (reconnect.provider !== provider || reconnect.subject.kind !== subject.kind)
      throw new Error('Existing Run provider or scope conflict');
    ensureStartupRecovery(config, runner, reconnect.id);
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
      verifyPermissions(owningRun);
      verifyRunRequirements(owningRun, requirements);
      verifyConstraints(owningRun);
      if (owningRun.provider !== provider)
        throw new Error('Existing child execution provider conflict');
      ensureStartupRecovery(config, runner, owningRun.id);
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
      verifyPermissions(existing);
      verifyRunRequirements(existing, requirements);
      verifyConstraints(existing);
      if (existing.provider !== provider || existing.subject.kind !== subject.kind)
        throw new Error('Existing Run provider or scope conflict');
      ensureStartupRecovery(config, runner, existing.id);
      return existing;
    }

    if (constraints?.kind === 'demo') {
      const roundRoot = dirname(config.project);
      const roundFile = join(roundRoot, 'round.json');
      if (!existsSync(roundFile)) {
        throw new Error(`Demo round ${constraints.roundId} manifest not found`);
      }
      const round = JSON.parse(readFileSync(roundFile, 'utf8'));
      if (round.id !== constraints.roundId) {
        throw new Error(`Demo round ID mismatch: expected ${constraints.roundId}, found ${round.id}`);
      }
      const expectedRepo = `${round.repository?.owner}/${round.repository?.name}`;
      if (subject.repository !== expectedRepo) {
        throw new Error(
          `Repository mismatch for demo round: expected ${expectedRepo}, received ${subject.repository}`,
        );
      }
      if (subject.number !== round.parent) {
        throw new Error(
          `Parent mismatch for demo round: expected ${round.parent}, received ${subject.number}`,
        );
      }
      if (provider !== 'agy') {
        throw new Error(`Provider mismatch for demo round: expected agy, received ${provider}`);
      }
      if (config.project !== round.checkout || config.root !== round.worktrees) {
        throw new Error('Configuration path mismatch for demo round');
      }
      const controlFile = join(roundRoot, 'control.json');
      if (!existsSync(controlFile)) {
        throw new Error(`Demo round ${round.id} is not armed; run pc demo arm first`);
      }
      const control = JSON.parse(readFileSync(controlFile, 'utf8'));
      if (!control.armed) {
        throw new Error(`Demo round ${round.id} is not armed; run pc demo arm first`);
      }
      if (control.stopped) {
        throw new Error(`Demo round ${round.id} is stopped; cannot start Run`);
      }
      if (control.activeMs >= control.budgetMs) {
        throw new Error(`Demo round ${round.id} budget expired; cannot start Run`);
      }
      if (control.runId) {
        throw new Error(`Demo round ${round.id} already bound to Run ${control.runId}`);
      }
    }

    const id = randomUUID();
    const directory = join(home(config), 'runs', id);
    mkdirSync(directory, { recursive: true });
    const brief = `Manage only ${subject.kind} ${subject.repository}#${subject.number}. Run ${id}. Provider ${provider}.\n${subject.parent ? `Parent context #${subject.parent}; no sibling or parent closure authorization.\n` : ''}${subject.title}\n${subject.body}${requirements === undefined ? '' : `\n\n## Run Requirements\n\n${requirements}`}`;
    const path = join(directory, 'brief.md');
    writeFileSync(path, brief, { mode: 0o400, flag: 'wx' });
    const run: WorkflowRun = {
      id,
      subject,
      provider,
      ...(dangerouslySkipPermissions ? { dangerouslySkipPermissions: true } : {}),
      policy: { name: 'managed-run', revision: 1 },
      lifecycle: 'reserved',
      ...(requirements === undefined ? {} : { requirements }),
      ...(constraints === undefined
        ? {}
        : { constraints: { ...constraints, boundAt: new Date().toISOString() } }),
      orchestratorId: id,
      launchStarted: false,
      brief: { path, hash: createHash('sha256').update(brief).digest('hex') },
    };
    registry.runs.push(run);
    reserveSubject(registry, run.id, `${subject.repository}#${subject.number}`);
    save(config, registry);

    if (constraints?.kind === 'demo') {
      const roundRoot = dirname(config.project);
      const controlFile = join(roundRoot, 'control.json');
      const control = JSON.parse(readFileSync(controlFile, 'utf8'));
      control.runId = id;
      control.execution = 'running';
      writeFileSync(controlFile, JSON.stringify(control, null, 2));
    }

    // The durable reservation survives a crash or failed launch and blocks replacement.
    try {
      run.launchStarted = true;
      save(config, registry);
      run.orchestrator = await startOrchestrator(
        config,
        runner,
        brief,
        id,
        {
          registry: join(home(config), 'registry.json'),
          authority: id,
          run: id,
          subject: `${subject.repository}#${subject.number}`,
          context: run.brief,
        },
        run.dangerouslySkipPermissions,
      );
      run.lifecycle = run.orchestrator.status === 'running' ? 'running' : 'blocked';
    } catch (error) {
      run.lifecycle = 'blocked';
      save(config, registry);
      throw error;
    }
    save(config, registry);
    ensureStartupRecovery(config, runner, run.id);
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
    attemptId: string;
    status: 'pending' | 'delivered' | 'uncertain' | 'completed';
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
  /** Additional assigned messages covered by this durable completion claim. */
  messageIds?: string[];
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
    if (request.role === 'worker') {
      const boundaryFile = join(roundRoot, 'delivery-boundaries.jsonl');
      const boundaries = existsSync(boundaryFile)
        ? readFileSync(boundaryFile, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
      const hasGatePass = boundaries.some((b: { pass?: boolean }) => b.pass === true);
      if (!hasGatePass) {
        throw new Error(
          `Worker dispatch denied: matching Gate authorization required for demo round ${owningRun.constraints.roundId}`,
        );
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
        const boundaryFile = join(roundRoot, 'delivery-boundaries.jsonl');
        const boundaries = existsSync(boundaryFile)
          ? readFileSync(boundaryFile, 'utf8')
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line))
          : [];
        const hasGatePass = boundaries.some((b: { pass?: boolean }) => b.pass === true);
        if (!hasGatePass) {
          throw new Error(
            `Worker dispatch denied: matching Gate authorization required for demo round ${run.constraints.roundId}`,
          );
        }
      }
    }
    if (runner.name !== run.provider) throw new Error('Run provider mismatch');
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
      !run.epicClosure
    )
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
      ...(run.dangerouslySkipPermissions ? { dangerouslySkipPermissions: true } : {}),
      dispatchId: id,
      persistent: !!runner.result,
      ...(runner.automaticStartup || runner.separateActivation ? { startupGate: true } : {}),
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
      terminalSession: run.provider === 'agy' ? undefined : request.terminalSession,
      writableDirectories: request.writableDirectories,
    };
    if (attempt.initialization) {
      attempt.initialization.attempt = attempt.id;
      if (runner.name !== 'agy')
        attempt.brief += initializationInstructions(attempt.initialization, attempt.directory);
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
  runner?: RunnerAdapter,
): Promise<void> {
  const snapshot = inspectRuns(config);
  const receipt = snapshot.receipts?.find((r) => r.id === receiptId);
  if (!receipt) throw new Error('Unknown Receipt');
  const dispatch = findDispatch(snapshot, receipt.dispatchId);
  authorize(snapshot, dispatch.runId, authority);
  const release = async () => {
    const current = findDispatch(inspectRuns(config), dispatch.id);
    if (
      current.attempts.at(-1)?.persistent &&
      !current.messages?.some((m) => m.status !== 'completed')
    )
      await stopAcceptedExecution(
        config,
        runner ?? managedRunner(current.provider),
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
      ...(runner.automaticStartup || runner.separateActivation ? { startupGate: true } : {}),
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
      if (runner.name !== 'agy')
        next.brief += initializationInstructions(next.initialization, next.directory);
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
  verifyRunRequirements(run);
  if (run.constraints?.kind === 'demo') {
    if (options.replaceOrchestrator) {
      throw new Error(`Replacement Orchestrator not authorized for demo-constrained Run ${run.id}`);
    }
  }
  if (run.lifecycle === 'completed')
    throw new Error('Completed Run authority has ended; start a new Run after resolving occupancy');
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
      {
        registry: join(home(config), 'registry.json'),
        authority: run.orchestratorId,
        run: run.id,
        subject: `${run.subject.repository}#${run.subject.number}`,
        context: run.brief,
      },
      run.dangerouslySkipPermissions,
    );
    updateRunRegistry(config, (registry) => {
      const current = registry.runs.find((r) => r.id === runId)!;
      current.orchestrator = attempt;
      current.lifecycle = attempt.status === 'running' ? 'running' : 'blocked';
    });
    return recoverRun(config, runner, runId);
  }
  const blockers: string[] = [];
  if (run.constraints?.kind === 'demo') {
    const roundRoot = dirname(config.project);
    const controlFile = join(roundRoot, 'control.json');
    if (existsSync(controlFile)) {
      const control = JSON.parse(readFileSync(controlFile, 'utf8'));
      if (control.stopped || control.activeMs >= control.budgetMs) {
        blockers.push(`Demo round ${run.constraints.roundId} is stopped or expired`);
        updateRunRegistry(config, (registry) => {
          const r = registry.runs.find((x) => x.id === runId);
          if (r) r.lifecycle = 'blocked';
        });
      }
    }
  }
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
    if (runner.observe) {
      attempt.observation = await runner.observe(attempt);
      if (runner.name === 'agy' && attempt.observation.status === 'unknown') {
        attempt.status = 'unknown';
      }
    }
    if (
      (attempt.status !== 'running' || (attempt === orchestrator && run.lifecycle !== 'running')) &&
      runner.recoverReceipt
    ) {
      let ack;
      try {
        ack = await runner.recoverReceipt(attempt);
      } catch (error) {
        blockers.push(`${attempt.id}: ${String(error)}; inspect ${attempt.directory}`);
        continue;
      }
      if (ack?.conversation && ack.address && ack.evidence) {
        try {
          if (attempt.initialization) verifyRoleInitialization(attempt);
          else if (runner.name === 'agy') throw new Error('Missing initialization context');
          recovered.set(attempt.id, ack);
          if (runner.observe) attempt.observation = await runner.observe(attempt);
        } catch (error) {
          blockers.push(`${attempt.id}: ${String(error)}; inspect ${attempt.directory}`);
        }
      }
    }
    if (runner.name === 'agy' && attempt.observation?.status === 'unknown')
      blockers.push(`${attempt.id}: ${attempt.observation.evidence}; occupancy unresolved`);
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
      await runner.prepareReplacement?.(orchestrator, [
        orchestrator,
        ...(run.priorOrchestrators ?? []),
        ...(snapshot.dispatches?.filter((d) => d.runId === runId).flatMap((d) => d.attempts) ?? []),
      ]);
      const id = randomUUID();
      const directory = join(home(config), 'runs', runId, id);
      mkdirSync(directory, { recursive: true });
      replacement = {
        ...orchestrator,
        paneId: undefined,
        windowId: undefined,
        observation: undefined,
        error: undefined,
        startupFailures: undefined,
        ...(runner.automaticStartup || runner.separateActivation ? { startupGate: true } : {}),
        activation: undefined,
        startupStopped: undefined,
        predecessor: orchestrator.id,
        id,
        directory,
        status: 'starting',
        created: new Date().toISOString(),
        conversation: options.newConversation ? undefined : orchestrator.conversation,
        brief: assignmentWithRequirements(
          run,
          `Reconcile durable Run ${runId} evidence before continuing. Scope reference: ${run.brief.path}. Do not replay the original brief or repeat accepted work.`,
        ),
        address: undefined,
        evidence: undefined,
      };
    }
  }
  if (replacement) {
    if (replacement.initialization) {
      replacement.initialization = {
        ...replacement.initialization,
        attempt: replacement.id,
        authority: replacement.id,
        briefHash: createHash('sha256').update(replacement.brief).digest('hex'),
      };
      if (runner.name !== 'agy')
        replacement.brief += initializationInstructions(
          replacement.initialization,
          replacement.directory,
        );
    }
    writeFileSync(join(replacement.directory, 'brief.md'), replacement.brief, {
      mode: 0o400,
      flag: 'wx',
    });
  }
  updateRunRegistry(config, (registry) => {
    if (registry.revision !== snapshot.revision) throw new Error('Recovery inputs changed; retry');
    const current = registry.runs.find((r) => r.id === runId)!;
    if (orchestrator?.run === runId) {
      current.orchestrator = orchestrator;
      const ack = recovered.get(orchestrator.id);
      if (ack) {
        if (current.orchestrator.error) {
          (current.orchestrator.startupFailures ??= []).push({
            error: current.orchestrator.error,
            resolvedAt: new Date().toISOString(),
          });
          delete current.orchestrator.error;
        }
        Object.assign(current.orchestrator, ack, { status: 'running' });
        if (runner.automaticStartup && runner.name === 'agy')
          current.orchestrator.startupGate = true;
      }
    }
    if (replacement) {
      (current.priorOrchestrators ??= []).push(orchestrator!);
      current.orchestrator = replacement;
      current.orchestratorId = replacement.id; // revoke old mutation authority before launch
      current.lifecycle = 'blocked';
    } else if (
      current.orchestrator?.status === 'running' &&
      (run.lifecycle === 'running' || recovered.has(current.orchestrator.id))
    )
      current.lifecycle = 'running';
    else {
      current.lifecycle = 'blocked';
      blockers.push('Orchestrator startup pending; unknown occupancy remains reserved');
    }
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
      if (ack) {
        if (attempt.error) {
          (attempt.startupFailures ??= []).push({
            error: attempt.error,
            resolvedAt: new Date().toISOString(),
          });
          delete attempt.error;
        }
        Object.assign(attempt, ack);
        if (attempt.initialization) verifyRoleInitialization(attempt);
        Object.assign(attempt, ack, { status: 'running' });
      }
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
      Object.assign(replacement, ack);
      if (replacement.initialization) verifyRoleInitialization(replacement);
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
  await reconcileStartup(config, runner, runId);
  ensureStartupRecovery(config, runner, runId);
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
  if (!['codex', 'agy', 'claude'].includes(run.provider))
    throw new Error(`Unsupported Run provider: ${String(run.provider)}`);
  if (run.lifecycle === 'completed')
    throw new Error(`Completed Run ${run.id} authority has ended; start later work with ${next}`);
  if (run.lifecycle !== 'running' || !run.orchestrator || run.orchestrator.status !== 'running')
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
      `No Run owns ${repository}#${number}; run pc workflow orchestrator start ${number} --type <issue|epic> --provider <provider> --config ${config.file}`,
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
  runner: RunnerAdapter & {
    collect(a: ManagedAttempt): Promise<string>;
    stopped?(a: ManagedAttempt): Promise<boolean>;
  },
  attempt: ManagedAttempt,
  validate?: (result: string) => void,
  options?: { timeoutMs?: number; messageIds?: string[] },
): Promise<string> {
  let result: string | undefined;
  if (runner.interactive && runner.result && attempt.dispatchId) {
    const deadline = options?.timeoutMs !== undefined ? Date.now() + options.timeoutMs : undefined;
    for (;;) {
      result = await runner.result(attempt, attempt.dispatchId);
      if (result !== undefined) break;
      if (runner.stopped && (await runner.stopped(attempt))) {
        throw new Error('Runner stopped without a correlated task result');
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new Error('Timed out waiting for correlated task result');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } else {
    result = await runner.collect(attempt);
  }
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
  runner?: RunnerAdapter,
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
  const attempt = updateRunRegistry(config, (registry) => {
    const dispatch = findDispatch(registry, dispatchId);
    authorize(registry, dispatch.runId, authority);
    if (dispatch.provider !== runner.name) throw new Error('Run provider mismatch');
    if (dispatch.lifecycle === 'accepted')
      throw new Error('Accepted task requires a new Dispatch for follow-up assignment');
    const existing = dispatch.messages?.find((m) => m.id === message.id);
    if (existing) {
      if (existing.brief !== message.brief)
        throw new Error('Message identity already bound to different input');
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
  if (runner.name !== dispatch.provider) throw new Error('Run provider mismatch');
  if (dispatch.lifecycle !== 'accepted' || dispatch.messages?.some((m) => m.status !== 'completed'))
    throw new Error('Acceptance and reconciled input required before release');
  const attempt = dispatch.attempts.at(-1)!;
  if (!runner.stopped) throw new Error('Verified termination capability required');
  if (!(await runner.stopped(attempt))) {
    const cancellation = await cancelAttempt(attempt, runner);
    if (cancellation.cancellation?.outcome !== 'confirmed' || !(await runner.stopped(attempt)))
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

/** Commit externally verified closure after accepted integrated goal judgment and delivery. */
export async function closeStageEpic(
  config: FleetConfig,
  runId: string,
  authority: string,
  dispatchId: string,
  confirmation: { deliveryVersion: string; source: 'human'; evidence: string },
  observe: () => Promise<{ head: string; closed: boolean; evidence: string }>,
) {
  const snapshot = inspectRuns(config);
  const run = authorize(snapshot, runId, authority);
  const dispatch = findDispatch(snapshot, dispatchId);
  const deliveries = snapshot.deliveries?.filter((d) => d.runId === runId) ?? [];
  const facts = await observe();
  const version = createHash('sha256')
    .update(JSON.stringify({ head: facts.head, deliveries }))
    .digest('hex');
  if (
    run.subject.kind !== 'epic' ||
    dispatch.runId !== runId ||
    dispatch.role !== 'epic' ||
    dispatch.stage !== 'integrated-acceptance' ||
    dispatch.lifecycle !== 'accepted' ||
    dispatch.inputRevision !== facts.head ||
    !deliveries.length ||
    deliveries.some((d) => d.status !== 'done' || !d.recorded || !d.released || !d.archive) ||
    confirmation.source !== 'human' ||
    !confirmation.evidence.trim() ||
    confirmation.deliveryVersion !== version ||
    !facts.closed ||
    !facts.evidence.trim()
  )
    throw new Error(
      'Expected accepted integrated goal, completed delivery, current human confirmation and verified closure',
    );
  const receipt = snapshot.receipts!.find((r) => r.id === dispatch.acceptedReceipt)!;
  verifyRetainedStageEvidence(receipt);
  const judgment = JSON.parse(readFileSync(receipt.evidence[0].path, 'utf8'));
  if (
    judgment.satisfied !== true ||
    !judgment.criteria?.length ||
    !Array.isArray(judgment.blockers) ||
    judgment.blockers.length
  )
    throw new Error('Integrated goal remains unaccepted');
  updateRunRegistry(config, (registry) => {
    const current = authorize(registry, runId, authority);
    if (registry.revision !== snapshot.revision)
      throw new Error('Registry changed during closure verification');
    current.epicClosure = {
      deliveryVersion: version,
      head: facts.head,
      evidence: facts.evidence,
      confirmed: confirmation.evidence,
    };
    current.phase = 'post_closure_finalization';
  });
  return { deliveryVersion: version, head: facts.head };
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
  if (
    !run.epicClosure ||
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
        control.releasing = true;
        control.execution = 'released';
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
  if (!run) throw new Error('Unknown Run');

  const dispatches = (registry.dispatches ?? []).filter((d) => d.runId === run.id);
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
    deliveries,
    pullRequests,
    resources,
    helper,
    reconciliation: run.reconciliation,
    execution,
    terminated,
    released,
  };
}

/** Read narrow public views of all registered Runs. */
export function inspectRunViews(config: FleetConfig): WorkflowRunView[] {
  const registry = inspectRuns(config);
  return registry.runs.map((r) => inspectRun(config, r.id));
}

/** Revoke scheduling and activation before terminating owned executions and helpers, preserving business records. */
export async function stopRun(
  config: FleetConfig,
  runnerOrId?: RunnerAdapter | string,
  runIdOrOptions?:
    | string
    | {
        stopped?: (attempt: ManagedAttempt) => Promise<boolean>;
        cleanup?: () => void;
      },
  options?: {
    stopped?: (attempt: ManagedAttempt) => Promise<boolean>;
    cleanup?: () => void;
  },
): Promise<StopRunResult> {
  const runId = typeof runnerOrId === 'string' ? runnerOrId : (runIdOrOptions as string);
  const passedRunner = typeof runnerOrId === 'string' ? undefined : runnerOrId;
  const opts = (typeof runIdOrOptions === 'object' ? runIdOrOptions : options) ?? {};

  if (!runId || !/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error('Expected a valid Run id');

  const snapshot = inspectRuns(config);
  const targetRun = snapshot.runs.find((r) => r.id === runId);
  if (!targetRun) throw new Error('Unknown Run');

  const adapter = passedRunner ?? managedRunner(targetRun.provider);
  if (adapter.name !== targetRun.provider) throw new Error('Run provider mismatch');

  // Revoke further scheduling and activation before requesting cancellation
  updateRunRegistry(config, (registry) => {
    const current = registry.runs.find((r) => r.id === runId);
    if (!current) throw new Error('Unknown Run');
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

  const hasTermination = (
    r: unknown,
  ): r is { termination: (a: ManagedAttempt) => Promise<boolean> } =>
    typeof (r as { termination?: unknown })?.termination === 'function';

  const isStopped =
    opts.stopped ??
    (adapter.stopped
      ? (a: ManagedAttempt) => adapter.stopped!(a)
      : hasTermination(adapter)
        ? (a: ManagedAttempt) => adapter.termination(a)
        : async () => false);

  const currentSnapshot = inspectRuns(config);
  const currentRun = currentSnapshot.runs.find((r) => r.id === runId)!;
  const attempts = [
    ...(currentRun.priorOrchestrators ?? []),
    ...(currentRun.orchestrator ? [currentRun.orchestrator] : []),
    ...(currentSnapshot.dispatches?.filter((d) => d.runId === runId).flatMap((d) => d.attempts) ?? []),
  ];

  const attemptResults: StopRunResult['attempts'] = [];

  for (const attempt of attempts) {
    let stopped = await isStopped(attempt);
    let cancellationControl: AttemptControl['cancellation'] | undefined;
    let error: string | undefined;

    if (!stopped) {
      try {
        const control = await cancelAttempt(attempt, adapter);
        cancellationControl = control.cancellation;
      } catch (err) {
        error = String(err);
      }
      stopped = await isStopped(attempt);
    }

    if (stopped) {
      await reconcileAttempt(attempt, { termination: isStopped });
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
      blockers.push(
        `Attempt ${attempt.id} (${attempt.role}) termination unverified; occupancy remains reserved`,
      );
    }

    attemptResults.push({
      id: attempt.id,
      role: attempt.role,
      status: stopped ? 'unknown' : attempt.status,
      terminated: stopped,
      cancellation: cancellationControl,
      error,
    });
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
  runnerOrId?: RunnerAdapter | string,
  runIdOrOptions?:
    | string
    | {
        stopped?: (attempt: ManagedAttempt) => Promise<boolean>;
        cleanup?: () => void;
      },
  options?: {
    stopped?: (attempt: ManagedAttempt) => Promise<boolean>;
    cleanup?: () => void;
  },
): Promise<ReleaseRunResult> {
  const runId = typeof runnerOrId === 'string' ? runnerOrId : (runIdOrOptions as string);
  const passedRunner = typeof runnerOrId === 'string' ? undefined : runnerOrId;
  const opts = (typeof runIdOrOptions === 'object' ? runIdOrOptions : options) ?? {};

  if (!runId || !/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error('Expected a valid Run id');

  const snapshot = inspectRuns(config);
  const targetRun = snapshot.runs.find((r) => r.id === runId);
  if (!targetRun) throw new Error('Unknown Run');

  if (targetRun.lifecycle !== 'completed') {
    throw new Error(
      `Run ${runId} is not completed (lifecycle: ${targetRun.lifecycle}); only completed Runs can be released with releaseRun`,
    );
  }

  const adapter = passedRunner ?? managedRunner(targetRun.provider);
  if (adapter.name !== targetRun.provider) throw new Error('Run provider mismatch');

  // Stop startup helper
  const helperStopped = await stopStartupRecovery(config, runId);
  const helperStatus = startupRecoveryStatus(config, runId);
  const blockers: string[] = [];
  if (helperStatus.active) {
    blockers.push('Startup helper termination unverified; helper remains active');
  }

  const hasTermination = (
    r: unknown,
  ): r is { termination: (a: ManagedAttempt) => Promise<boolean> } =>
    typeof (r as { termination?: unknown })?.termination === 'function';

  const isStopped =
    opts.stopped ??
    (adapter.stopped
      ? (a: ManagedAttempt) => adapter.stopped!(a)
      : hasTermination(adapter)
        ? (a: ManagedAttempt) => adapter.termination(a)
        : async () => false);

  const attempts = [
    ...(targetRun.priorOrchestrators ?? []),
    ...(targetRun.orchestrator ? [targetRun.orchestrator] : []),
    ...(snapshot.dispatches?.filter((d) => d.runId === runId).flatMap((d) => d.attempts) ?? []),
  ];

  const attemptResults: ReleaseRunResult['attempts'] = [];

  for (const attempt of attempts) {
    let stopped = await isStopped(attempt);
    let cancellationControl: AttemptControl['cancellation'] | undefined;
    let error: string | undefined;

    if (!stopped) {
      try {
        const control = await cancelAttempt(attempt, adapter);
        cancellationControl = control.cancellation;
      } catch (err) {
        error = String(err);
      }
      stopped = await isStopped(attempt);
    }

    if (stopped) {
      await reconcileAttempt(attempt, { termination: isStopped });
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
      blockers.push(
        `Attempt ${attempt.id} (${attempt.role}) termination unverified; occupancy remains reserved`,
      );
    }

    attemptResults.push({
      id: attempt.id,
      role: attempt.role,
      status: stopped ? 'unknown' : attempt.status,
      terminated: stopped,
      cancellation: cancellationControl,
      error,
    });
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

