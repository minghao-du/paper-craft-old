import type { WorkflowRole } from '../runtime/workflow-role.js';
import type { ManagedAttempt } from '../runtime/runtime.js';
import { inspectRuns, type WorkflowRun, type RunRegistry } from '../run/run-registry.js';
/** File-backed evidence shared by Dashboard and JSON CLI; never scheduling authority. */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { loadFleetConfig, workflowSource, within } from './fleet-config.js';

/** Registered monitoring source; project is an optional research association. */
export interface FleetRegistration {
  id: string;
  config: string;
  project?: string;
}
/** Durable execution evidence is separate from current liveness and acceptance. */
export interface DashboardExecution {
  attempts: {
    id: string;
    role: WorkflowRole;
    runner: string;
    conversation?: string;
    address?: string;
    predecessor?: string;
    recordedStatus: string;
    execution: string;
    observation?: ManagedAttempt['observation'];
    stale: boolean;
    error?: string;
    startupFailures?: ManagedAttempt['startupFailures'];
  }[];
  acceptance: 'accepted' | 'reported' | 'unknown' | 'conflicting';
  receipts: { id: string; attemptId: string; outcome: string; accepted: boolean }[];
  uncertainty: string;
}
function executionEvidence(
  attempts: ManagedAttempt[],
  registry: RunRegistry,
  dispatchId?: string,
): DashboardExecution {
  const receipts = (registry.receipts ?? []).filter(
    (r) => r.dispatchId === dispatchId && dispatchId !== undefined,
  );
  const dispatch = registry.dispatches?.find((d) => d.id === dispatchId);
  const accepted = receipts.find((r) => r.id === dispatch?.acceptedReceipt);
  const conflicting = Boolean(
    dispatch?.acceptedReceipt && (!accepted || accepted.attemptId !== attempts.at(-1)?.id),
  );
  return {
    attempts: attempts.map((a) => ({
      id: a.id,
      role: a.role,
      runner: a.runner,
      conversation: a.conversation,
      address: a.address,
      predecessor: a.predecessor,
      recordedStatus: a.status,
      execution: a.observation?.status ?? 'unknown',
      observation: a.observation,
      stale:
        !a.observation ||
        !Number.isFinite(Date.parse(a.observation.at)) ||
        Date.now() - Date.parse(a.observation.at) > 300000,
      error: a.error,
      startupFailures: a.startupFailures,
    })),
    acceptance: conflicting
      ? 'conflicting'
      : accepted
        ? 'accepted'
        : receipts.length
          ? 'reported'
          : 'unknown',
    receipts: receipts.map((r) => ({
      id: r.id,
      attemptId: r.attemptId,
      outcome: r.outcome,
      accepted: r.id === accepted?.id && !conflicting,
    })),
    uncertainty:
      'Recorded observations are not current liveness. Conversation reuse does not merge attempts. Missing observations and monitoring gaps remain unknown; this is not a complete execution history.',
  };
}
/** Attributed task evidence; runtime presence never grants ownership. */
export interface DashboardTask {
  id: string;
  slot: string;
  path: string;
  role: WorkflowRole;
  source: string;
  phase: string;
  summary: string;
  blockers: string[];
  waiting?: 'planned' | 'overdue' | 'unknown';
  modifiedAt?: string;
  interventions?: { reason: string; source: string }[];
  issue?: number;
  pr?: string;
  runtime: 'unknown';
  /** Verified registry ownership, absent on legacy file-only tasks. */
  runId?: string;
  orchestratorId?: string;
  executionIdentity: string;
  executionEvidence?: DashboardExecution;
  observedAt: string;
  stale: boolean;
  error?: string;
  /** Durable dispatch identity, distinct from verified process liveness. */
  dispatchId?: string;
  fleetId?: string;
  handled?: boolean;
}
/** One registered Fleet, including failures instead of disappearing registrations. */
export interface DashboardFleet {
  id: string;
  config: string;
  project?: string;
  observedAt: string;
  tasks: DashboardTask[];
  /** Run ownership is projected without mutating runtime state. */
  runs?: WorkflowRun[];
  /** Distinct reported, acknowledged and accepted milestones; no control authority. */
  execution?: Omit<RunRegistry, 'runs'>;
  error?: string;
  stale: boolean;
}
/** Read only bounded, physically contained JSON evidence. */
export async function readDashboardFleet(registration: FleetRegistration): Promise<DashboardFleet> {
  const observedAt = new Date().toISOString();
  const fleet: DashboardFleet = { ...registration, observedAt, tasks: [], stale: false };
  try {
    const config = loadFleetConfig(registration.config);
    const { runs, ...execution } = inspectRuns(config);
    fleet.runs = runs;
    fleet.execution = execution;
    for (const run of fleet.runs) {
      const blockers = [
        ...(run.subject.blockedBy ?? []).map((n) => `Dependency #${n} remains open`),
        ...(run.orchestrator?.error ? [run.orchestrator.error] : []),
        ...(run.reconciliation?.blockers ?? []),
        ...(run.pipeline?.blockers ?? []),
        ...(run.pipeline &&
        ['changes_needed', 'acceptance_invalidated'].includes(run.pipeline.disposition)
          ? [`Pipeline ${run.pipeline.disposition}`]
          : []),
      ];
      const interventions = blockers.map((reason) => ({ reason, source: run.brief.path }));
      if (['blocked'].includes(run.phase ?? run.lifecycle) && !blockers.length)
        interventions.push({
          reason: 'Recorded phase requests human intervention',
          source: run.brief.path,
        });
      const lastAttempt = run.orchestrator ?? run.priorOrchestrators?.at(-1);
      const modifiedAt = lastAttempt?.observation?.at ?? lastAttempt?.created ?? observedAt;
      const runDelivery = (execution.deliveries ?? []).find((d) => d.runId === run.id);
      fleet.tasks.push({
        id: `${registration.id}:run:${run.id}`,
        slot: `run-${run.id}`,
        path: config.project,
        role: 'orchestrator',
        source: run.brief.path,
        phase: run.phase ?? run.lifecycle,
        summary:
          run.subject.title ??
          `${run.subject.repository}#${run.subject.number} (${run.provider})${run.subject.parent ? `; child of #${run.subject.parent}` : ''}`,
        issue: run.subject.number,
        pr: runDelivery?.pr ? String(runDelivery.pr) : undefined,
        blockers,
        interventions,
        modifiedAt,
        runId: run.id,
        orchestratorId: run.orchestratorId,
        executionEvidence: executionEvidence(
          [...(run.priorOrchestrators ?? []), ...(run.orchestrator ? [run.orchestrator] : [])],
          { runs, ...execution },
        ),
        runtime: 'unknown',
        executionIdentity: 'unknown',
        observedAt,
        stale: false,
      });
    }
    for (const dispatch of execution.dispatches ?? []) {
      const attempt = dispatch.attempts.at(-1);
      const issueNum = dispatch.subject ? Number(dispatch.subject.split('#').at(-1)) : undefined;
      const blockers = [
        ...(attempt?.error ? [attempt.error] : []),
        ...(attempt?.observation?.status === 'error' && attempt.observation.evidence
          ? [attempt.observation.evidence]
          : []),
      ];
      const interventions = blockers.map((reason) => ({
        reason,
        source: dispatch.briefReference.path,
      }));
      fleet.tasks.push({
        id: `${registration.id}:managed:${dispatch.id}`,
        slot: `managed-${dispatch.id}`,
        path: attempt?.checkout ?? config.project,
        role: dispatch.role,
        source: dispatch.briefReference.path,
        phase: dispatch.lifecycle,
        summary: dispatch.stage,
        blockers,
        interventions,
        modifiedAt: attempt?.observation?.at ?? attempt?.created,
        issue: Number.isFinite(issueNum) ? issueNum : undefined,
        runId: dispatch.runId,
        dispatchId: dispatch.id,
        runtime: 'unknown',
        executionIdentity: attempt?.id ?? 'unknown',
        observedAt,
        stale: false,
        executionEvidence: executionEvidence(
          dispatch.attempts,
          { runs, ...execution },
          dispatch.id,
        ),
      });
    }
    for (const delivery of execution.deliveries ?? []) {
      if (execution.dispatches?.some((d) => delivery.dispatches?.includes(d.id))) {
        continue;
      }
      fleet.tasks.push({
        id: `${registration.id}:delivery:${delivery.runId}:${delivery.pr ?? delivery.issue ?? 'done'}`,
        slot: `delivery-${delivery.pr ?? delivery.issue ?? 'done'}`,
        path: delivery.archive ?? config.project,
        role: 'landing',
        source: delivery.archive ?? config.project,
        phase: delivery.status,
        summary: `Delivered ${delivery.repository}${delivery.issue ? `#${delivery.issue}` : ''}${delivery.pr ? ` (PR #${delivery.pr})` : ''}`,
        issue: delivery.issue,
        pr: delivery.pr ? String(delivery.pr) : undefined,
        blockers: [],
        runId: delivery.runId,
        runtime: 'unknown',
        executionIdentity: 'unknown',
        observedAt,
        stale: false,
      });
    }
  } catch (error) {
    fleet.error = error instanceof Error ? error.message : 'Cannot load Fleet configuration';
  }
  return fleet;
}

function resolveAttemptLog(attempt?: ManagedAttempt, fallbackDir?: string): string {
  const dir =
    attempt?.directory && existsSync(attempt.directory)
      ? realpathSync(attempt.directory)
      : attempt?.directory;
  if (dir) {
    const attemptLog = join(dir, 'attempt.log');
    if (existsSync(attemptLog)) return attemptLog;
    const transcript = join(dir, 'transcript.jsonl');
    if (existsSync(transcript)) return transcript;
    const agyNative = join(dir, 'agy-native.json');
    if (existsSync(agyNative)) {
      try {
        const parsed = JSON.parse(readFileSync(agyNative, 'utf8'));
        if (typeof parsed.transcript_path === 'string' && existsSync(parsed.transcript_path)) {
          return realpathSync(parsed.transcript_path);
        }
      } catch {
        /* ignore invalid agy-native.json */
      }
    }
  }
  const checkoutDir =
    attempt?.checkout && existsSync(attempt.checkout)
      ? realpathSync(attempt.checkout)
      : attempt?.checkout;
  if (checkoutDir) {
    const checkoutAttemptLog = join(checkoutDir, 'attempt.log');
    if (existsSync(checkoutAttemptLog)) return checkoutAttemptLog;
    const checkoutTranscript = join(checkoutDir, 'transcript.jsonl');
    if (existsSync(checkoutTranscript)) return checkoutTranscript;
  }
  if (dir) {
    return join(dir, 'attempt.log');
  }
  const fallback =
    fallbackDir && existsSync(fallbackDir) ? realpathSync(fallbackDir) : fallbackDir;
  return join(fallback ?? '', 'attempt.log');
}

/** Revalidate a dispatch or run before reading its checkout or log; never trust a cached path. */
export function dashboardTaskSource(
  configFile: string,
  task: DashboardTask,
): { directory: string; log: string } {
  const config = loadFleetConfig(configFile);
  if (!task.dispatchId) {
    const { runs } = inspectRuns(config);
    const run = task.runId ? runs?.find((r) => r.id === task.runId) : undefined;
    const attempt = run?.orchestrator ?? run?.priorOrchestrators?.at(-1);
    const directory = workflowSource(config, task.path || config.project);
    return { directory, log: resolveAttemptLog(attempt, directory) };
  }
  const { dispatches } = inspectRuns(config);
  const dispatch = dispatches?.find(
    (d) => d.id === task.dispatchId && (!task.runId || d.runId === task.runId),
  );
  if (!dispatch) throw new Error('Unknown or missing dispatch');
  const attempt = dispatch.attempts.at(-1);
  const checkout = attempt?.checkout ?? config.project;
  if (dispatch.briefReference.path !== task.source || checkout !== task.path)
    throw new Error('Dispatch source changed');
  if (!existsSync(checkout)) {
    if (!within(config.project, checkout) && !within(config.root, checkout)) {
      throw new Error(`Dispatch checkout is outside configured project or root: ${checkout}`);
    }
    return { directory: checkout, log: resolveAttemptLog(attempt, checkout) };
  }
  const directory = workflowSource(config, checkout);
  return { directory, log: resolveAttemptLog(attempt, directory) };
}
