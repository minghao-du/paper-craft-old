import { readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { workflowSource, type FleetConfig } from '../fleet/fleet-config.js';
import type { ManagedAttempt } from '../runtime/runtime.js';
import {
  home,
  inspectRuns,
  updateRunRegistry,
  type RunRegistry,
  type WorkflowRun,
} from './run-registry.js';

/**
 * Validate that the specified authority currently controls the run.
 */
function authorizeAuthority(
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
  ) {
    throw new Error('Inactive or wrong Orchestrator authority');
  }
  return run;
}

/**
 * Physically record ownership of a checkout via `.pc-execution-owner` file and registry entry.
 * Hides physical-owner validation and occupancy checks.
 */
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
    let prior: { runId?: string; registry?: string };
    try {
      prior = JSON.parse(readFileSync(path, 'utf8'));
    } catch (parseError) {
      throw new Error('Unknown checkout occupancy', { cause: parseError });
    }
    if (prior.runId !== runId || prior.registry !== owner.registry) {
      throw new Error(`Checkout occupied: ${checkout}`, { cause: error });
    }
  }
  registry.resources ??= [];
  if (!registry.resources.some((r) => r.path === checkout)) registry.resources.push(owner);
}

/**
 * Find subject ownership for existing internal workflow projections.
 */
function findSubjectOrchestrator(
  config: FleetConfig,
  repository: string,
  number: number,
  registry?: RunRegistry,
): ManagedAttempt | undefined {
  const reg = registry ?? inspectRuns(config);
  const owner = reg.subjects?.find((s) => s.subject === `${repository}#${number}`)?.ownerRunId;
  const run = reg.runs.find(
    (r) =>
      r.id === owner ||
      (!owner &&
        r.subject.repository === repository &&
        r.subject.number === number &&
        r.lifecycle !== 'completed'),
  );
  return run?.orchestrator;
}

/**
 * Reference an existing subject execution; never manufacture a second owner.
 * If the subject is unowned, assigns it to the given run.
 * If the subject is already owned by the given run, returns that run id.
 * If owned by another run, records this run as a consumer and throws an error indicating the current owner.
 */
export function reserveSubject(registry: RunRegistry, runId: string, subject: string): string {
  registry.subjects ??= [];
  const existing = registry.subjects.find((s) => s.subject === subject);
  if (existing) {
    if (existing.ownerRunId !== runId && !existing.consumingRunIds.includes(runId)) {
      existing.consumingRunIds.push(runId);
    }
    if (existing.ownerRunId !== runId) {
      throw new Error(`Subject owned by Run ${existing.ownerRunId}`);
    }
    return existing.ownerRunId;
  }
  registry.subjects.push({ subject, ownerRunId: runId, consumingRunIds: [] });
  return runId;
}

/**
 * Release a physical checkout directory previously reserved by a Run.
 * Requires independent termination evidence for every execution using the checkout.
 * Enforces revision match, validates physical ownership token, and executes cleanup.
 */
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
  if (!attempts.length || !(await Promise.all(attempts.map(stopped))).every(Boolean)) {
    throw new Error('Unknown checkout occupancy; termination evidence required');
  }
  updateRunRegistry(config, (registry) => {
    if (registry.revision !== snapshot.revision) throw new Error('Ownership changed; retry');
    const path = join(physical, '.pc-execution-owner');
    const owner = JSON.parse(readFileSync(path, 'utf8'));
    if (owner.runId !== runId || owner.registry !== join(home(config), 'registry.json')) {
      throw new Error('Checkout owner conflict');
    }
    cleanup?.();
    rmSync(path, { force: true });
    registry.resources = registry.resources?.filter((r) => r.path !== physical);
  });
}

/**
 * Require an active subject Run and its recorded provider before command dispatch.
 * Returns the running Orchestrator attempt for the subject.
 */
export function orchestratorForSubject(
  config: FleetConfig,
  repository: string,
  number: number,
  registry?: RunRegistry,
): ManagedAttempt {
  const reg = registry ?? inspectRuns(config);
  const attempt = findSubjectOrchestrator(config, repository, number, reg);
  const run = reg.runs.find((r) => r.id === attempt?.run);
  const next = `pc workflow orchestrator start ${number} --type <issue|epic> --provider <provider> --config ${config.file}`;
  if (!run) throw new Error(`No Run owns ${repository}#${number}; run ${next}`);
  if (!run.provider) {
    throw new Error('Missing Run provider');
  }
  if (run.lifecycle === 'completed') {
    throw new Error(`Completed Run ${run.id} authority has ended; start later work with ${next}`);
  }
  if (run.lifecycle !== 'running' || !run.orchestrator || run.orchestrator.status !== 'running') {
    throw new Error(
      `No active Orchestrator for Run ${run.id}; run pc workflow orchestrator recover ${run.id} --config ${config.file}`,
    );
  }
  if (run.orchestrator.runner !== run.provider) {
    throw new Error(
      `Run provider mismatch: expected provider ${run.provider}, but received ${run.orchestrator.runner}`,
    );
  }
  return run.orchestrator;
}

/**
 * Record a consuming Run reference without granting another execution owner.
 * Supports operating within an existing RunRegistry transaction when passed.
 */
export function referenceRunSubject(
  config: FleetConfig,
  runId: string,
  subject: string,
  registry?: RunRegistry,
): string {
  const perform = (reg: RunRegistry): string => {
    if (!reg.runs.some((r) => r.id === runId)) {
      throw new Error(`Unknown Run: expected existing run with id ${runId}`);
    }
    reg.subjects ??= [];
    const owner = reg.subjects.find((s) => s.subject === subject);
    if (!owner) return reserveSubject(reg, runId, subject);
    if (owner.ownerRunId !== runId && !owner.consumingRunIds.includes(runId)) {
      owner.consumingRunIds.push(runId);
    }
    return owner.ownerRunId;
  };

  if (registry) {
    return perform(registry);
  }
  return updateRunRegistry(config, perform);
}

/**
 * Reserve a physical checkout directory for an active Run under a verified authority.
 * Supports operating within an existing RunRegistry transaction when passed,
 * or runs a new transaction if omitted.
 */
export function reserveRunCheckout(
  config: FleetConfig,
  runId: string,
  authority: string,
  checkout: string,
  registry?: RunRegistry,
): void {
  const physical = workflowSource(config, checkout);
  const perform = (reg: RunRegistry): void => {
    if (authority) {
      authorizeAuthority(reg, runId, authority);
    }
    reserveCheckout(config, reg, runId, physical);
  };
  if (registry) {
    perform(registry);
    return;
  }
  updateRunRegistry(config, perform);
}
