/** Durable startup reconciliation; provider executions and business acceptance remain separate. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FleetConfig } from '../fleet/fleet-config.js';
import {
  inspectOrchestrator,
  type ManagedAttempt,
  type RunnerAdapter,
} from '../runtime/runtime.js';
import {
  inspectRuns,
  updateRunRegistry,
  verifyRunRequirements,
  type RunRegistry,
} from './run-driver.js';
import { verifyRoleInitialization } from './role-initialization.js';
export {
  startupDirectory,
  startupRecoveryStatus,
  ensureStartupRecovery,
  stopStartupRecovery,
} from '../runtime/startup-supervisor.js';

function attempts(registry: RunRegistry, runId: string): ManagedAttempt[] {
  const run = registry.runs.find((r) => r.id === runId);
  if (!run || run.lifecycle === 'completed') return [];
  return [
    ...(run.orchestrator && run.orchestrator.id === run.orchestratorId ? [run.orchestrator] : []),
    ...(registry.dispatches ?? [])
      .filter(
        (d) =>
          d.runId === runId &&
          d.authority === run.orchestratorId &&
          !['accepted', 'superseded', 'rejected'].includes(d.lifecycle) &&
          !d.remediation?.exhausted,
      )
      .flatMap((d) => d.attempts.slice(-1)),
  ];
}
const pending = (a: ManagedAttempt) =>
  !a.startupStopped &&
  (a.status !== 'running' || (a.startupGate && a.activation?.status !== 'delivered'));

/** Inspect whether this Run still owns unfinished startup work. */
export function startupPending(
  config: FleetConfig,
  runId: string,
  registry?: RunRegistry,
): boolean {
  const snapshot = registry ?? inspectRuns(config);
  const run = snapshot.runs.find((r) => r.id === runId);
  return (
    !!run &&
    run.lifecycle !== 'completed' &&
    ((run.launchStarted === true && !run.orchestrator) || attempts(snapshot, runId).some(pending))
  );
}

/** One reconciliation pass. Returns true while a live/unknown startup still needs observation. */
export async function reconcileStartup(
  config: FleetConfig,
  runner: RunnerAdapter,
  runId: string,
): Promise<boolean> {
  let waiting = false;
  const snapshot = inspectRuns(config);
  const owner = snapshot.runs.find((r) => r.id === runId);
  if (!owner) throw new Error(`Unknown Run: expected existing run with id ${runId}`);
  if (owner.provider !== runner.name)
    throw new Error(
      `Run provider mismatch: expected provider ${owner.provider}, but received ${runner.name}`,
    );
  if (owner.lifecycle === 'completed') return false;
  verifyRunRequirements(owner);
  if (owner.constraints?.kind === 'demo') {
    const roundRoot = dirname(config.project);
    const controlFile = join(roundRoot, 'control.json');
    if (existsSync(controlFile)) {
      const control = JSON.parse(readFileSync(controlFile, 'utf8'));
      if (control.stopped || control.activeMs >= control.budgetMs) {
        updateRunRegistry(config, (registry) => {
          for (const a of attempts(registry, runId)) {
            a.startupStopped = true;
            a.status = 'unknown';
            a.error = 'Demo round budget expired or stopped during startup; occupancy retained';
          }
          const run = registry.runs.find((r) => r.id === runId);
          if (run) run.lifecycle = 'blocked';
        });
        return false;
      }
    }
  }
  if (owner.launchStarted === true && !owner.orchestrator) {
    const durable = inspectOrchestrator(config, runId);
    if (!durable || durable.run !== runId || durable.id !== owner.orchestratorId) return true;
    updateRunRegistry(config, (registry) => {
      const run = registry.runs.find((r) => r.id === runId);
      if (
        run &&
        run.lifecycle !== 'completed' &&
        !run.orchestrator &&
        run.orchestratorId === durable.id
      ) {
        run.orchestrator = durable;
        run.lifecycle = 'blocked';
      }
    });
  }
  for (const observed of attempts(inspectRuns(config), runId).filter(
    (a) => pending(a) && (a.startupGate || runner.automaticStartup),
  )) {
    try {
      if (await runner.stopped?.(observed)) {
        updateRunRegistry(config, (registry) => {
          const current = attempts(registry, runId).find((a) => a.id === observed.id);
          if (current) {
            current.startupStopped = true;
            current.status = 'unknown';
            const run = registry.runs.find((r) => r.id === runId)!;
            if (run.orchestratorId === current.id) run.lifecycle = 'blocked';
            current.error =
              'Execution stopped before startup connection completed; occupancy retained';
          }
        });
        continue;
      }
      if (observed.status !== 'running') {
        const receipt = await runner.recoverReceipt?.(observed);
        if (!receipt?.conversation || !receipt.address || !receipt.evidence) {
          waiting = true;
          continue;
        }
        verifyRoleInitialization(observed);
        updateRunRegistry(config, (registry) => {
          const current = attempts(registry, runId).find((a) => a.id === observed.id);
          if (!current) return;
          if (current.error)
            (current.startupFailures ??= []).push({
              error: current.error,
              resolvedAt: new Date().toISOString(),
            });
          Object.assign(current, receipt, { status: 'running', error: undefined });
          if (
            runner.automaticStartup &&
            current.role === 'orchestrator' &&
            !current.dispatchId &&
            runner.name === 'agy'
          )
            current.startupGate = true;
          const run = registry.runs.find((r) => r.id === runId)!;
          if (current.id === run.orchestratorId) run.lifecycle = 'running';
          else {
            const dispatch = registry.dispatches?.find((d) => d.attempts.at(-1)?.id === current.id);
            if (dispatch?.lifecycle === 'reserved') dispatch.lifecycle = 'running';
          }
        });
      }
      const current = attempts(inspectRuns(config), runId).find((a) => a.id === observed.id);
      if (!current?.startupGate || current.activation?.status === 'delivered') continue;
      // The completed ready turn must be independently visible before sending another input.
      if (!(await runner.recoverReceipt?.(current))) {
        waiting = true;
        continue;
      }
      verifyRoleInitialization(current);
      const run = inspectRuns(config).runs.find((r) => r.id === runId)!;
      if (run.lifecycle !== 'running') {
        waiting = true;
        continue;
      }
      let send = false;
      const activation = updateRunRegistry(config, (registry) => {
        const selected = attempts(registry, runId).find((a) => a.id === current.id);
        if (!selected || registry.runs.find((r) => r.id === runId)?.lifecycle !== 'running')
          return undefined;
        if (!selected.activation) {
          selected.activation = {
            id: `activate-${selected.id}`,
            brief: `Managed startup activated: Run ${runId}, Attempt ${selected.id}, role ${selected.role}. Verify the owning Run still reports this exact active authority in ${selected.initialization?.registry}. Continue only the immutable assigned work from ${selected.directory}/brief.md. Initialization is already complete; do not repeat initialization or emit ready again. Read durable results first; completed or accepted work must not repeat. This message continues initialization; it is not task acceptance.`,
            status: 'uncertain',
            evidence: 'Activation intent persisted before delivery',
          };
          send = true;
        }
        return selected.activation;
      });
      if (!activation || activation.status === 'delivered') continue;
      let delivery: { status: 'delivered' | 'uncertain'; evidence: string };
      if (send) {
        try {
          delivery = await runner.send!(current, activation);
        } catch (error) {
          delivery = { status: 'uncertain', evidence: String(error) };
        }
      } else {
        const evidence = await runner.messageReceipt?.(current, activation);
        delivery = evidence
          ? { status: 'delivered', evidence }
          : { status: 'uncertain', evidence: activation.evidence };
      }
      updateRunRegistry(config, (registry) => {
        const selected = attempts(registry, runId).find((a) => a.id === current.id);
        if (
          selected?.activation?.id === activation.id &&
          selected.activation.status !== 'delivered'
        ) {
          Object.assign(selected.activation, delivery);
          if (delivery.status === 'delivered' && selected.error) {
            (selected.startupFailures ??= []).push({
              error: selected.error,
              resolvedAt: new Date().toISOString(),
            });
            delete selected.error;
          }
        }
      });
      if (delivery.status !== 'delivered') waiting = true;
    } catch (error) {
      waiting = true;
      const cause = String(error);
      updateRunRegistry(config, (registry) => {
        const current = attempts(registry, runId).find((a) => a.id === observed.id);
        if (current) current.error = cause;
      });
    }
  }
  return waiting;
}
