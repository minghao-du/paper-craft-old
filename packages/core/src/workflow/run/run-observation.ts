/** Run observation module: read-only views, status aggregation, and resource inspection. */
import type { FleetConfig } from '../fleet/fleet-config.js';
import {
  inspectAttemptControl,
  type ManagedAttempt,
} from '../runtime/runtime.js';
import { startupRecoveryStatus } from '../runtime/startup-supervisor.js';
import type { PipelineDisposition } from '../delivery/epic-finalization.js';
import type { ResearchReport } from '../delivery/research-report.js';
import {
  inspectRuns,
  type RunRegistry,
  type WorkflowRun,
  type RunConstraints,
  type RunSubject,
  type StageDispatch,
} from './run-registry.js';

export {
  inspectRuns,
  type RunRegistry,
  type WorkflowRun,
  type RunConstraints,
  type RunSubject,
  type StageDispatch,
} from './run-registry.js';

/** Execution status view for a Workflow Run. */
export type WorkflowRunExecutionView =
  | 'running'
  | 'reserved'
  | 'blocked'
  | 'completed'
  | 'unknown'
  | 'terminated';

/** Resource ownership view for a Workflow Run. */
export interface WorkflowRunResourceView {
  path: string;
  runId: string;
}

/** Startup helper status view for a Workflow Run. */
export interface WorkflowRunHelperView {
  active: boolean;
  pending?: boolean;
  evidenceDirectory?: string;
  error?: string;
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
  resources: WorkflowRunResourceView[];
  helper: WorkflowRunHelperView;
  reconciliation?: WorkflowRun['reconciliation'];
  execution: WorkflowRunExecutionView;
  terminated: boolean;
  released: boolean;
  epicClosure?: WorkflowRun['epicClosure'];
  pipeline?: PipelineDisposition;
  report?: ResearchReport;
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

  let execution: WorkflowRunExecutionView;
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
