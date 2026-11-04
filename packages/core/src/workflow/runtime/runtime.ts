import { assertWorkflowRole, type WorkflowRole } from './workflow-role.js';
/** Managed role startup and durable runner evidence, independent of the model host. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stateDirectory } from '../handoff.js';
import {
  verifyRoleInitialization,
  type RoleInitialization,
} from '../run/role-initialization.js';
import type { FleetConfig } from '../fleet/fleet-config.js';

/** One execution attempt; unknown retains occupancy until independently verified. */
export interface ManagedAttempt {
  id: string;
  fleet: string;
  /** Run ownership recorded at intake. */
  run?: string;
  role: WorkflowRole;
  runner: string;
  /** Previous process identity when this attempt replaces a terminated execution. */
  dispatchId?: string;
  /** The adapter supports correlated results from a process that remains alive. */
  persistent?: boolean;
  initialization?: RoleInitialization;
  predecessor?: string;
  observation?: ExecutionObservation;
  brief: string;
  status: 'starting' | 'running' | 'unknown';
  created: string;
  directory: string;
  checkout: string;
  /** Existing fleet session required for specialist windows. */
  terminalSession?: string;
  /** Explicit local writing roots passed to capable runners. */
  writableDirectories?: string[];
  /** Explicit Run-level opt-in to agy tool permission auto-approval. */
  dangerouslySkipPermissions?: boolean;
  conversation?: string;
  address?: string;
  /** Opaque provider-specific recovery information; Core persists this without reading or relying on internal fields. */
  providerState?: Record<string, unknown>;
  /** Deprecated interim provider fields; providers must encapsulate state in providerState. */
  windowId?: string;
  paneId?: string;
  evidence?: string;
  error?: string;
  /** End initialization before explicit activation input; persisted across caller exit. */
  startupGate?: boolean;
  /** Verified process termination stops startup observation, without releasing occupancy. */
  startupStopped?: boolean;
  /** Durable continuation intent; uncertain input is reconciled without replay. */
  activation?: { id: string; brief: string; status: 'delivered' | 'uncertain'; evidence: string };
  /** Resolved startup failures remain visible after exact-identity recovery. */
  startupFailures?: { error: string; resolvedAt: string }[];
}
/** Adapter owns capability checks and evidence; a terminal alone is insufficient. */
export interface RunnerAdapter {
  name: string;
  /** Native adapters opt into a detached per-Run startup reconciler. */
  automaticStartup?: boolean;
  /** Require separate activation with in-process startup reconciliation (controlled runners). */
  separateActivation?: boolean;
  /** Recover exact continuation input without replaying uncertain delivery. */
  messageReceipt?(
    attempt: ManagedAttempt,
    message: { id: string; brief: string },
  ): Promise<string | undefined>;
  /** Validate replacement terminal ownership; rebuild only with complete termination evidence. */
  prepareReplacement?(prior: ManagedAttempt, attempts: ManagedAttempt[]): Promise<void>;
  /** True only after the complete persistent interactive lifecycle is verified. */
  interactive?: boolean;
  /** Correlated input into the existing process; uncertainty forbids automatic replay. */
  send?(
    attempt: ManagedAttempt,
    message: { id: string; brief: string },
  ): Promise<{
    status: 'delivered' | 'uncertain';
    evidence: string;
  }>;
  /** Durable task output; implementations must not wait for process exit. */
  result?(attempt: ManagedAttempt, dispatchId: string): Promise<string | undefined>;
  /** Collect task execution result; handles polling, timeout, and stopped execution. */
  collect(
    attempt: ManagedAttempt,
    options?: { timeoutMs?: number; dispatchId?: string },
  ): Promise<string>;
  /** Observe execution independently of receipt acceptance. */
  observe?(attempt: ManagedAttempt): Promise<ExecutionObservation>;
  stopped?(attempt: ManagedAttempt): Promise<boolean>;
  /** Terminate execution and verify absence; callers do not manually compose cancel and stopped steps. */
  terminate?(attempt: ManagedAttempt): Promise<ExecutionTermination>;
  /** Recover normalized startup evidence from this Runner only. */
  recoverReceipt?(
    attempt: ManagedAttempt,
  ): Promise<{ conversation: string; address: string; evidence: string } | undefined>;
  cancellation?: boolean;
  cancel?(attempt: ManagedAttempt): Promise<{ evidence: string }>;
  preflight(): Promise<void>;
  start(
    attempt: ManagedAttempt,
  ): Promise<{ conversation: string; address: string; evidence: string }>;
}
function home(config: FleetConfig): string {
  return stateDirectory(config, '.runtime', createHash('sha256').update(config.file).digest('hex'));
}
function save(path: string, attempt: ManagedAttempt): void {
  assertWorkflowRole(attempt.role, path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(attempt, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
}
/** Read durable occupancy, without treating missing runtime evidence as release. */
export function inspectOrchestrator(config: FleetConfig, run: string): ManagedAttempt | undefined {
  if (!run || !/^[a-zA-Z0-9-]+$/.test(run)) throw new Error('Expected a valid Run id');
  const path = join(home(config), `orchestrator-${run}.json`);
  if (!existsSync(path)) return undefined;
  let attempt: ManagedAttempt;
  try {
    attempt = JSON.parse(readFileSync(path, 'utf8')) as ManagedAttempt;
  } catch (error) {
    throw new Error(`Corrupt orchestrator recovery evidence at ${path}: ${String(error)}`, {
      cause: error,
    });
  }
  assertWorkflowRole(attempt.role, path);
  if (attempt.role !== 'orchestrator') throw new Error(`${path}: expected orchestrator role`);
  if (attempt.run && attempt.run !== run)
    throw new Error(`${path}: expected run ${run}; received ${attempt.run}`);
  return attempt;
}
/** Exclusively claim the Run orchestrator, preserving failed/unknown launches for recovery. */
export async function startOrchestrator(
  config: FleetConfig,
  runner: RunnerAdapter,
  brief: string,
  run: string,
  initialization?: Omit<RoleInitialization, 'role' | 'attempt' | 'briefHash'>,
  dangerouslySkipPermissions?: boolean,
): Promise<ManagedAttempt> {
  if (!run || !/^[a-zA-Z0-9-]+$/.test(run)) throw new Error('Expected a valid Run id');
  if (!brief.trim()) throw new Error('Expected a non-empty Orchestrator brief');
  requireInteractive(runner);
  await runner.preflight();
  mkdirSync(home(config), { recursive: true });
  try {
    mkdirSync(join(home(config), `orchestrator-${run}.lock`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error('Orchestrator occupied; inspect persisted attempt before recovery', {
        cause: error,
      });
    throw error;
  }
  const id = run;
  const directory = join(home(config), id);
  mkdirSync(directory);
  const attempt: ManagedAttempt = {
    id,
    run,
    fleet: createHash('sha256').update(config.file).digest('hex'),
    role: 'orchestrator',
    runner: runner.name,
    persistent: !!runner.result,
    ...(runner.automaticStartup || runner.separateActivation || runner.result ? { startupGate: true } : {}),
    brief,
    status: 'starting',
    created: new Date().toISOString(),
    directory,
    checkout: config.project,
    ...(dangerouslySkipPermissions
      ? { dangerouslySkipPermissions: true, providerState: { dangerouslySkipPermissions: true } }
      : {}),
  };
  if (!run || !/^[a-zA-Z0-9-]+$/.test(run)) throw new Error('Expected a valid Run id');
  const path = join(home(config), `orchestrator-${run}.json`);
  if (runner.result) {
    if (!initialization)
      throw new Error('Persistent Orchestrator requires Run-derived initialization context');
    attempt.initialization = {
      ...initialization,
      role: attempt.role,
      attempt: attempt.id,
      briefHash: createHash('sha256').update(brief).digest('hex'),
    };
  }
  save(path, attempt);
  writeFileSync(join(directory, 'brief.md'), attempt.brief, { mode: 0o600 });
  try {
    const receipt = await runner.start(attempt);
    if (!receipt.conversation || !receipt.address || !receipt.evidence)
      throw new Error('Expected Runner conversation, runtime address and startup evidence');
    Object.assign(attempt, receipt);
    if (attempt.initialization) verifyRoleInitialization(attempt);
    Object.assign(attempt, receipt, { status: 'running' });
  } catch (error) {
    attempt.status = 'unknown';
    attempt.error = error instanceof Error ? error.message : String(error);
  }
  save(path, attempt);
  save(join(directory, 'attempt.json'), attempt);
  return attempt;
}
/**
 * Escape a shell argument by wrapping it in single quotes.
 * General shell quoting helper used across hosts, providers, and CLI utilities.
 */
export function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/** Control observations do not overwrite the persisted execution identity or ownership. */
export interface AttemptControl {
  execution?: { status: 'running' | 'unknown' | 'terminated'; evidence?: string };
  wait?: { timedOut: boolean; at: string };
  cancellation?: {
    requested: string;
    outcome: 'unsupported' | 'failed' | 'confirmed';
    evidence?: string;
    error?: string;
  };
}

/**
 * Execution termination outcome: verified process termination or explicit unconfirmed outcome.
 * Callers do not need to manually compose provider-specific cancel and stopped steps.
 */
export interface ExecutionTermination {
  status: 'terminated' | 'unconfirmed';
  evidence?: string;
  error?: string;
}

/**
 * Execute verified termination through the runner contract or return an explicit unconfirmed outcome.
 * Callers do not need to compose provider-specific cancel and stopped steps.
 */
export async function terminateAttempt(
  attempt: ManagedAttempt,
  runner: {
    terminate?(attempt: ManagedAttempt): Promise<ExecutionTermination>;
    stopped?(attempt: ManagedAttempt): Promise<boolean>;
    cancellation?: boolean;
    cancel?(attempt: ManagedAttempt): Promise<{ evidence: string }>;
  },
): Promise<ExecutionTermination> {
  const control = inspectAttemptControl(attempt);
  let outcome: ExecutionTermination;
  try {
    if (runner.terminate) {
      outcome = await runner.terminate(attempt);
    } else {
      const alreadyStopped = runner.stopped ? await runner.stopped(attempt) : false;
      if (alreadyStopped) {
        outcome = { status: 'terminated', evidence: 'Process already stopped' };
      } else if (runner.cancellation && runner.cancel) {
        const receipt = await runner.cancel(attempt);
        const confirmed = runner.stopped ? await runner.stopped(attempt) : true;
        if (confirmed) {
          outcome = { status: 'terminated', evidence: receipt.evidence ?? 'Cancellation confirmed' };
        } else {
          outcome = { status: 'unconfirmed', error: 'Process still running after cancellation' };
        }
      } else {
        outcome = { status: 'unconfirmed', error: 'Runner does not support cancellation or termination' };
      }
    }
  } catch (error) {
    outcome = {
      status: 'unconfirmed',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const file = join(attempt.directory, 'control.json');
  if (outcome.status === 'terminated') {
    control.execution = { status: 'terminated', evidence: outcome.evidence };
    control.cancellation = {
      requested: new Date().toISOString(),
      outcome: 'confirmed',
      evidence: outcome.evidence,
    };
  } else {
    control.execution = { status: 'unknown' };
    control.cancellation = {
      requested: new Date().toISOString(),
      outcome: 'failed',
      error: outcome.error,
    };
  }
  writeFileSync(file, JSON.stringify(control));
  return outcome;
}
/** Read durable wait/cancellation observations, independently of execution status. */
export function inspectAttemptControl(attempt: ManagedAttempt): AttemptControl {
  const file = join(attempt.directory, 'control.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}
/** A bounded wait leaves the original collection running and permits later collection. */
export async function waitAttempt(
  attempt: ManagedAttempt,
  runner: Pick<RunnerAdapter, 'collect'>,
  timeoutMs: number,
): Promise<{ timedOut: boolean; result?: string }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('Expected nonnegative timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      runner.collect(attempt).then((result) => ({ timedOut: false, result })),
      new Promise<{ timedOut: boolean }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      }),
    ]);
    const control = inspectAttemptControl(attempt);
    control.wait = { timedOut: result.timedOut, at: new Date().toISOString() };
    writeFileSync(join(attempt.directory, 'control.json'), JSON.stringify(control));
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
/** Cancellation is unsupported unless the adapter explicitly supplies a terminal receipt. */
export async function cancelAttempt(
  attempt: ManagedAttempt,
  runner: {
    cancellation?: boolean;
    cancel?(attempt: ManagedAttempt): Promise<{ evidence: string }>;
  },
): Promise<AttemptControl> {
  const control = inspectAttemptControl(attempt);
  control.cancellation = { requested: new Date().toISOString(), outcome: 'failed' };
  const file = join(attempt.directory, 'control.json');
  writeFileSync(file, JSON.stringify(control));
  try {
    if (!runner.cancellation || !runner.cancel) control.cancellation.outcome = 'unsupported';
    else {
      const receipt = await runner.cancel(attempt);
      if (!receipt.evidence) throw new Error('Expected verified termination receipt');
      Object.assign(control.cancellation, { outcome: 'confirmed', evidence: receipt.evidence });
      control.execution = { status: 'terminated', evidence: receipt.evidence };
    }
  } catch (error) {
    control.cancellation.error = String(error);
  }
  writeFileSync(file, JSON.stringify(control));
  return control;
}

/** Reconcile execution without changing logical role or checkout ownership. */
export async function reconcileAttempt(
  attempt: ManagedAttempt,
  runner: { termination?(attempt: ManagedAttempt): Promise<boolean>; stopped?(attempt: ManagedAttempt): Promise<boolean> },
): Promise<AttemptControl> {
  const control = inspectAttemptControl(attempt);
  if (control.execution?.status === 'terminated') return control;
  const terminated = runner.termination
    ? await runner.termination(attempt)
    : runner.stopped
      ? await runner.stopped(attempt)
      : false;
  control.execution = terminated
    ? { status: 'terminated', evidence: 'Adapter verified execution exit' }
    : { status: 'unknown' };
  writeFileSync(join(attempt.directory, 'control.json'), JSON.stringify(control));
  return control;
}

/** A timestamped execution observation never grants task acceptance or ownership. */
export interface ExecutionObservation {
  status: 'running' | 'idle' | 'waiting' | 'error' | 'exited' | 'unknown';
  at: string;
  evidence: string;
}
/** Named roles require persistent interactive execution; adapters must explicitly opt in. */
export function requireInteractive(runner: RunnerAdapter): void {
  if (runner.interactive !== true)
    throw new Error(`${runner.name} lacks verified persistent interactive lifecycle support`);
}

export { AgyInteractive } from './agy-interactive.js';
