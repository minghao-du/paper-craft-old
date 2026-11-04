import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FleetConfig } from '../fleet/fleet-config.js';
import {
  inspectAttemptControl,
  reconcileAttempt,
  terminateAttempt,
  type AttemptControl,
  type ExecutionTermination,
  type ManagedAttempt,
  type RunnerAdapter,
} from '../runtime/runtime.js';
import { startupRecoveryStatus, stopStartupRecovery } from '../runtime/startup-supervisor.js';
import { releaseRunCheckout } from './run-ownership.js';
import {
  inspectRuns,
  updateRunRegistry,
  type WorkflowRun,
} from './run-registry.js';

/** Options for stopRun and releaseRun control operations. */
export interface RunControlOptions {
  /** Optional custom predicate to check if an attempt has stopped. */
  stopped?: (attempt: ManagedAttempt) => Promise<boolean>;
  /** Optional cleanup callback executed when releasing checkouts. */
  cleanup?: () => void;
}

/** Result of a verified stopRun operation. */
export interface StopRunResult {
  /** Unique Run identifier. */
  runId: string;
  /** Lifecycle status of the Run after stopping. */
  lifecycle: WorkflowRun['lifecycle'];
  /** Whether all attempts were verified as terminated. */
  terminated: boolean;
  /** Whether all executions terminated and resources were released. */
  released: boolean;
  /** Outcomes for each attempt inspected during stop. */
  attempts: {
    id: string;
    role: ManagedAttempt['role'];
    status: ManagedAttempt['status'];
    terminated: boolean;
    cancellation?: AttemptControl['cancellation'];
    error?: string;
  }[];
  /** Status of the startup helper supervisor. */
  helper: {
    active: boolean;
    pending?: boolean;
    stopped: boolean;
  };
  /** Resources currently remaining registered to this Run. */
  resources: { path: string; runId: string }[];
  /** Blockers preventing complete termination or release. */
  blockers: string[];
}

/** Result of a completed releaseRun operation. */
export interface ReleaseRunResult {
  /** Unique Run identifier. */
  runId: string;
  /** Lifecycle status of the Run (must be completed). */
  lifecycle: WorkflowRun['lifecycle'];
  /** Whether all attempts were verified as terminated. */
  terminated: boolean;
  /** Whether all executions terminated and resources were released. */
  released: boolean;
  /** Outcomes for each attempt inspected during release. */
  attempts: {
    id: string;
    role: ManagedAttempt['role'];
    status: ManagedAttempt['status'];
    terminated: boolean;
    cancellation?: AttemptControl['cancellation'];
    error?: string;
  }[];
  /** Status of the startup helper supervisor. */
  helper: {
    active: boolean;
    pending?: boolean;
    stopped: boolean;
  };
  /** Resources currently remaining registered to this Run. */
  resources: { path: string; runId: string }[];
  /** Blockers preventing complete release. */
  blockers: string[];
}

/**
 * Terminate an attempt and verify its stopped state, recording blockers if unverified.
 */
async function terminateAndVerifyAttempt(
  config: FleetConfig,
  adapter: RunnerAdapter,
  runId: string,
  attempt: ManagedAttempt,
  options?: RunControlOptions,
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

/**
 * Shared termination verification and cleanup logic for stopRun and releaseRun.
 */
async function terminateAndCleanupRun(
  config: FleetConfig,
  runner: RunnerAdapter,
  runId: string,
  options: RunControlOptions & { requireCleanupGateForResources: boolean },
): Promise<{
  lifecycle: WorkflowRun['lifecycle'];
  terminated: boolean;
  released: boolean;
  attempts: StopRunResult['attempts'];
  helper: StopRunResult['helper'];
  resources: { path: string; runId: string }[];
  blockers: string[];
}> {
  // Stop startup helper
  const helperStopped = await stopStartupRecovery(config, runId);
  const helperStatus = startupRecoveryStatus(config, runId);
  const blockers: string[] = [];
  if (helperStatus.active) {
    blockers.push('Startup helper termination unverified; helper remains active');
  }

  const isStopped =
    options.stopped ??
    (runner.stopped
      ? (a: ManagedAttempt) => runner.stopped!(a)
      : async (a: ManagedAttempt) => (await terminateAttempt(a, runner)).status === 'terminated');

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
      runner,
      runId,
      attempt,
      options,
    );
    if (blocker) {
      blockers.push(blocker);
    }
    attemptResults.push(result);
  }

  // Release checkouts
  const regBeforeCleanup = inspectRuns(config);
  const ownedResources = (regBeforeCleanup.resources ?? []).filter((r) => r.runId === runId);
  if (ownedResources.length > 0) {
    if (options.cleanup) {
      for (const res of ownedResources) {
        try {
          await releaseRunCheckout(config, runId, res.path, isStopped, options.cleanup);
        } catch (err) {
          blockers.push(`Resource ${res.path} release failed: ${String(err)}`);
        }
      }
    } else if (options.requireCleanupGateForResources) {
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

/**
 * Revoke scheduling and activation before terminating owned executions and helpers,
 * preserving business records.
 */
export async function stopRun(
  config: FleetConfig,
  runner: RunnerAdapter,
  runId: string,
  options?: RunControlOptions,
): Promise<StopRunResult> {
  const opts = options ?? {};

  if (!runId || !/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error('Expected a valid Run id');

  const snapshot = inspectRuns(config);
  const targetRun = snapshot.runs.find((r) => r.id === runId);
  if (!targetRun) throw new Error(`Unknown Run: expected existing run with id ${runId}`);

  if (runner.name !== targetRun.provider) {
    throw new Error(
      `Run provider mismatch: expected provider ${targetRun.provider}, but received ${runner.name}`,
    );
  }

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

  const outcome = await terminateAndCleanupRun(config, runner, runId, {
    ...opts,
    requireCleanupGateForResources: false,
  });

  return {
    runId,
    ...outcome,
  };
}

/**
 * Terminate remaining executions and helpers for a completed Run without changing
 * business success into failure. Accepts only completed Runs.
 */
export async function releaseRun(
  config: FleetConfig,
  runner: RunnerAdapter,
  runId: string,
  options?: RunControlOptions,
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

  if (runner.name !== targetRun.provider) {
    throw new Error(
      `Run provider mismatch: expected provider ${targetRun.provider}, but received ${runner.name}`,
    );
  }

  const outcome = await terminateAndCleanupRun(config, runner, runId, {
    ...opts,
    requireCleanupGateForResources: true,
  });

  return {
    runId,
    ...outcome,
  };
}
