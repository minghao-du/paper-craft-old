/** Batch recovery delegates authority and evidence reconciliation to each Run. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FleetConfig } from '../fleet/fleet-config.js';
import {
  inspectOrchestrator,
  requireInteractive,
  startOrchestrator,
  terminateAttempt,
  type ManagedAttempt,
  type RunnerAdapter,
} from '../runtime/runtime.js';
import {
  home,
  inspectRuns,
  updateRunRegistry,
  type StageReceipt,
} from './run-registry.js';
import {
  assignmentWithRequirements,
  ensureStartupRecovery,
  reconcileStartup,
  verifyRunRequirements,
} from './startup.js';
import { verifyRoleInitialization } from './role-initialization.js';

/**
 * Re-entry recovers durable claims and startup evidence; missing notifications never rerun work.
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
  if (!run) throw new Error(`Unknown Run: expected existing run with id ${runId}`);
  if (run.provider !== runner.name)
    throw new Error(
      `Run provider mismatch: expected provider ${run.provider}, but received ${runner.name}`,
    );
  verifyRunRequirements(run);
  if (run.lifecycle === 'completed')
    throw new Error('Completed Run authority has ended; start a new Run after resolving occupancy');
  const blockers: string[] = [];
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
  const pendingDispatches: string[] = [];
  const recovered = new Map<
    string,
    Awaited<ReturnType<NonNullable<RunnerAdapter['recoverReceipt']>>>
  >();
  let orchestrator = run.orchestrator;
  if (!orchestrator) {
    try {
      orchestrator = inspectOrchestrator(config, runId);
    } catch (error) {
      blockers.push(`Orchestrator recovery evidence corrupt: ${String(error)}`);
    }
  }
  if (orchestrator) {
    if (orchestrator.run && orchestrator.run !== runId) {
      throw new Error(
        `Run orchestrator ownership mismatch: expected ${runId}, received ${orchestrator.run}`,
      );
    }
    if (orchestrator.runner && orchestrator.runner !== run.provider) {
      throw new Error(
        `Run provider mismatch: expected provider ${run.provider}, but received ${orchestrator.runner}`,
      );
    }
  }
  const dispatches = snapshot.dispatches?.filter((d) => d.runId === runId) ?? [];
  for (const dispatch of dispatches) {
    for (const attempt of dispatch.attempts) {
      if (attempt.run && attempt.run !== runId) {
        throw new Error(
          `Dispatch attempt Run ownership mismatch: expected ${runId}, received ${attempt.run}`,
        );
      }
      if (attempt.runner && attempt.runner !== run.provider) {
        throw new Error(
          `Attempt provider mismatch: expected provider ${run.provider}, but received ${attempt.runner}`,
        );
      }
    }
  }
  const attempts = dispatches.flatMap((d) => d.attempts.slice(-1));
  for (const attempt of [...(orchestrator ? [orchestrator] : []), ...attempts]) {
    if (runner.observe) {
      attempt.observation = await runner.observe(attempt);
      if (attempt.observation.status === 'unknown') {
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
          else if (attempt.persistent) throw new Error('Missing initialization context');
          recovered.set(attempt.id, ack);
          if (runner.observe) attempt.observation = await runner.observe(attempt);
        } catch (error) {
          blockers.push(`${attempt.id}: ${String(error)}; inspect ${attempt.directory}`);
        }
      }
    }
    if (attempt.observation?.status === 'unknown')
      blockers.push(`${attempt.id}: ${attempt.observation.evidence}; occupancy unresolved`);
  }
  let replacement: ManagedAttempt | undefined;
  if (options.replaceOrchestrator) {
    let predecessorStopped = false;
    if (orchestrator && orchestrator.run === runId) {
      if (options.stopped) {
        predecessorStopped = await options.stopped(orchestrator);
      } else if (runner.stopped) {
        predecessorStopped = await runner.stopped(orchestrator);
      } else {
        const term = await terminateAttempt(orchestrator, runner);
        predecessorStopped = term.status === 'terminated';
      }
    }
    if (
      !orchestrator ||
      orchestrator.run !== runId ||
      !predecessorStopped
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
      const dangerouslySkipPermissions = Boolean(
        run.dangerouslySkipPermissions ?? orchestrator.dangerouslySkipPermissions,
      );
      replacement = {
        id,
        run: runId,
        fleet: orchestrator.fleet,
        role: 'orchestrator',
        runner: runner.name,
        persistent: orchestrator.persistent,
        brief: assignmentWithRequirements(
          run,
          `Reconcile durable Run ${runId} evidence before continuing. Scope reference: ${run.brief.path}. Do not replay the original brief or repeat accepted work.`,
        ),
        status: 'starting',
        created: new Date().toISOString(),
        directory,
        checkout: run.subject.repository ? config.project : orchestrator.checkout,
        writableDirectories: orchestrator.writableDirectories,
        predecessor: orchestrator.id,
        conversation: options.newConversation ? undefined : orchestrator.conversation,
        ...(runner.separateActivation || runner.result || orchestrator.startupGate
          ? { startupGate: true }
          : {}),
        dangerouslySkipPermissions: dangerouslySkipPermissions ? true : undefined,
        providerState: dangerouslySkipPermissions ? { dangerouslySkipPermissions: true } : undefined,
      };
      if (orchestrator.initialization) {
        replacement.initialization = {
          ...orchestrator.initialization,
          attempt: replacement.id,
          authority: replacement.id,
          briefHash: createHash('sha256').update(replacement.brief).digest('hex'),
        };
      }
      writeFileSync(join(replacement.directory, 'brief.md'), replacement.brief, {
        mode: 0o400,
        flag: 'wx',
      });
    }
  }
  updateRunRegistry(config, (registry) => {
    if (registry.revision !== snapshot.revision) throw new Error('Recovery inputs changed; retry');
    const current = registry.runs.find((r) => r.id === runId)!;
    if (orchestrator) {
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
        Object.assign(current.orchestrator, ack, { status: 'running', startupGate: true });
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
      if (existsSync(directory)) {
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
      else if (
        ['pipeline-audit', 'pipeline-refactor', 'research-state'].includes(dispatch.role) &&
        dispatch.lifecycle !== 'superseded'
      ) {
        if (!pendingDispatches.includes(dispatch.id)) pendingDispatches.push(dispatch.id);
      }
      else if (dispatch.remediation?.exhausted)
        blockers.push(`${dispatch.id}: remediation exhausted: ${dispatch.remediation.feedback}`);
      else if (attempt.status !== 'running')
        blockers.push(`${dispatch.id}: startup pending; verify occupancy before retry`);
    }

    if (current.epicClosure?.status === 'closed') {
      if (current.pipeline && current.report) {
        current.phase = 'completed';
        current.lifecycle = 'completed';
      } else {
        current.phase = 'post_closure_finalization';
        if (current.lifecycle !== 'blocked') {
          current.lifecycle = 'running';
        }
      }
    } else if (current.subject.kind === 'issue') {
      const delivery = registry.deliveries?.find((d) => d.runId === current.id);
      if (delivery?.status === 'done' && delivery?.released) {
        current.phase = 'completed';
        current.lifecycle = 'completed';
      }
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

/** Reconcile all incomplete Runs independently; never adopt unowned legacy work. */
export async function recoverAllRuns(
  config: FleetConfig,
  runnerFor: (provider: string) => RunnerAdapter,
) {
  const outcomes: {
    run: string;
    blockers?: string[];
    pendingDispatches?: string[];
    error?: string;
  }[] = [];
  let runs;
  try {
    runs = inspectRuns(config).runs;
  } catch (error) {
    return {
      status: 'unknown' as const,
      error: `Failed to inspect fleet runs: ${String(error)}`,
      outcomes,
    };
  }
  for (const run of runs.filter((r) => r.lifecycle !== 'completed')) {
    try {
      const runner = runnerFor(run.provider);
      outcomes.push({ run: run.id, ...(await recoverRun(config, runner, run.id)) });
    } catch (error) {
      outcomes.push({ run: run.id, error: String(error) });
    }
  }
  return {
    status: outcomes.some((o) => o.error || o.blockers?.length) ? 'unknown' : 'reconciled',
    outcomes,
  };
}
