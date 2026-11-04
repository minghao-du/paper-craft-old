/** Registry storage: snapshot reads, synchronous transactions, paths, locks, and atomic saves. */
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { claimDriver } from './driver-lock.js';
import { stateDirectory } from '../handoff.js';
import type { FleetConfig } from '../fleet/fleet-config.js';
import { assertStageRole, assertWorkflowRole } from '../runtime/workflow-role.js';
import type { ManagedAttempt } from '../runtime/runtime.js';
import type { PipelineDisposition, EpicFinalization } from '../delivery/epic-finalization.js';
import type { ResearchReport } from '../delivery/research-report.js';
import type { IssueInput } from './run-subject.js';

export { claimDriver } from './driver-lock.js';

/** Verified tracker subject, with explicit scope rather than title heuristics. */
export interface RunSubject extends IssueInput {
  kind: 'issue' | 'epic';
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
  pipeline?: PipelineDisposition;
  pipelineApprovals?: Record<string, { source: 'human'; ledger: string; evidence: string }>;
  pipelineMaintenance?: EpicFinalization['maintenanceDeliveries'];
  report?: ResearchReport;
  epicClosure?: { deliveryVersion: string; head: string; evidence: string; confirmed: string; status?: 'closed' };
  orchestratorId: string;
  launchStarted?: boolean;
  orchestrator?: ManagedAttempt;
  brief: { path: string; hash: string };
  requirements?: string;
  reconciliation?: { at: string; blockers: string[]; pendingDispatches: string[] };
  priorOrchestrators?: ManagedAttempt[];
  humanConfirmation?: { source: 'human'; deliveryVersion: string; evidence: string };
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

/** Runtime state root directory for a fleet configuration. */
export function home(config: FleetConfig): string {
  return stateDirectory(config, '.runtime', createHash('sha256').update(config.file).digest('hex'));
}

/** Validate workflow and stage roles across all attempts, dispatches, and receipts. */
export function validateRegistryRoles(registry: RunRegistry, source: string): void {
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

/** Read only; absent legacy Run identities are never fabricated. */
export function inspectRuns(config: FleetConfig): RunRegistry {
  const file = join(home(config), 'registry.json');
  const registry: RunRegistry = existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8'))
    : { revision: 0, runs: [] };
  validateRegistryRoles(registry, file);
  return registry;
}

/** Atomically writes the registry to disk, incrementing its revision. */
export function save(config: FleetConfig, registry: RunRegistry): void {
  validateRegistryRoles(registry, 'Run registry');
  const file = join(home(config), 'registry.json');
  const temp = file + '.' + randomUUID();
  registry.revision++;
  writeFileSync(temp, JSON.stringify(registry, null, 2), { mode: 0o600 });
  renameSync(temp, file);
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

/**
 * Locate a StageDispatch by ID within the registry, throwing if absent.
 */
export function findDispatch(registry: RunRegistry, id: string): StageDispatch {
  const dispatch = registry.dispatches?.find((d) => d.id === id);
  if (!dispatch) throw new Error('Unknown Dispatch');
  return dispatch;
}

/**
 * Validate that the specified authority currently controls the run.
 */
export function authorize(
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


