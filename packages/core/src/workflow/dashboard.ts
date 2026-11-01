import { readWorkerInventory } from './worker-inventory.js';
import { inspectRuns, type WorkflowRun, type RunRegistry } from './run-driver.js';
/** File-backed evidence shared by Dashboard and JSON CLI; never scheduling authority. */
import { readFile, realpath, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { loadFleetConfig, workflowSource, within } from './fleet-config.js';

/** Registered monitoring source; project is an optional research association. */
export interface FleetRegistration {
  id: string;
  config: string;
  project?: string;
}
/** Attributed task evidence; runtime and execution attempts remain unknown. */
export interface DashboardTask {
  id: string;
  slot: string;
  path: string;
  role: string;
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
  executionIdentity: 'unknown';
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
      fleet.tasks.push({
        id: `${registration.id}:run:${run.id}`,
        slot: `run-${run.id}`,
        path: config.project,
        role: 'Orchestrator',
        source: run.brief.path,
        phase: run.phase ?? run.lifecycle,
        summary: `${run.subject.repository}#${run.subject.number} (${run.provider})${run.subject.parent ? `; child of #${run.subject.parent}` : ''}`,
        issue: run.subject.number,
        blockers: [
          ...(run.subject.blockedBy ?? []).map((n) => `Dependency #${n} remains open`),
          ...(run.orchestrator?.error ? [run.orchestrator.error] : []),
          ...(run.reconciliation?.blockers ?? []),
          ...(run.pipeline?.blockers ?? []),
          ...(run.pipeline &&
          ['changes_needed', 'acceptance_invalidated'].includes(run.pipeline.disposition)
            ? [`Pipeline ${run.pipeline.disposition}`]
            : []),
        ],
        runId: run.id,
        orchestratorId: run.orchestratorId,
        runtime: 'unknown',
        executionIdentity: 'unknown',
        observedAt,
        stale: false,
      });
    }
    const workers = readWorkerInventory(config.project);
    for (const worker of workers) {
      fleet.tasks.push({
        id: `${registration.id}:dispatch:${worker.fleet_id}:${worker.dispatch_id}`,
        slot: `${worker.role}-${worker.dispatch_id}`,
        path: worker.worktree,
        role: worker.role,
        source: worker.source,
        phase: worker.state,
        summary: worker.receipt?.match(/^summary:\s*(.*)$/m)?.[1] ?? '',
        blockers: [],
        issue: worker.issue_id,
        runId: worker.run_id,
        dispatchId: worker.dispatch_id,
        fleetId: worker.fleet_id,
        handled: worker.handled,
        runtime: 'unknown',
        executionIdentity: 'unknown',
        observedAt,
        stale: false,
        modifiedAt: worker.modifiedAt,
      });
    }
    const names = config.worktrees
      ? (await readdir(config.root)).filter((n) => /^issue-\d+$/.test(n))
      : config.slots;
    const locations = [
      { slot: 'orchestrator', path: config.project },
      ...names.map((slot) => ({ slot, path: join(config.root, slot) })),
    ];
    for (const location of locations) {
      const task: DashboardTask = {
        ...location,
        id: `${registration.id}:${location.slot}`,
        role: location.slot === 'orchestrator' ? 'Orchestrator / configured EPIC' : 'Worker',
        source: join(location.path, '.epic-status.json'),
        phase: 'unknown',
        summary: '',
        blockers: [],
        runtime: 'unknown',
        executionIdentity: 'unknown',
        observedAt,
        stale: false,
      };
      try {
        workflowSource(config, location.path);
        const physical = await realpath(task.source);
        if (!within(location.path, physical))
          throw new Error('Status source escapes registered directory');
        if ((await stat(physical)).size > 256 * 1024)
          throw new Error('Status exceeds 256 KiB limit');
        const value: unknown = JSON.parse(await readFile(physical, 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('Expected status object');
        const record = value as Record<string, unknown>;
        task.phase = typeof record.phase === 'string' ? record.phase : 'unknown';
        task.summary = typeof record.summary === 'string' ? record.summary : '';
        task.blockers = Array.isArray(record.blockers)
          ? record.blockers.filter((v): v is string => typeof v === 'string')
          : [];
        task.interventions = task.blockers.map((reason) => ({ reason, source: task.source }));
        if (['needs-human', 'blocked'].includes(task.phase) && !task.blockers.length)
          task.interventions.push({
            reason: 'Recorded phase requests human intervention',
            source: task.source,
          });
        for (const field of ['stop_reason', 'lead_guidance']) {
          if (typeof record[field] === 'string' && record[field])
            task.interventions.push({ reason: record[field], source: `${task.source}#${field}` });
        }
        const awaiting =
          record.awaiting && typeof record.awaiting === 'object'
            ? (record.awaiting as Record<string, unknown>)
            : undefined;
        const appointment =
          typeof awaiting?.next_check_at === 'string' ? Date.parse(awaiting.next_check_at) : NaN;
        const statusTime = (await stat(physical)).mtimeMs;
        let worklogTime = 0;
        try {
          const worklog = await realpath(join(location.path, '.epic-worklog.md'));
          if (within(location.path, worklog)) worklogTime = (await stat(worklog)).mtimeMs;
        } catch {
          /* Missing worklog does not invalidate status evidence. */
        }
        task.modifiedAt = new Date(Math.max(statusTime, worklogTime)).toISOString();
        if (task.phase === 'awaiting-results') {
          task.waiting = Number.isFinite(appointment)
            ? appointment > Date.now()
              ? 'planned'
              : 'overdue'
            : 'unknown';
          if (task.waiting === 'overdue')
            task.interventions.push({
              reason: 'Saved next check is overdue; investigate',
              source: task.source,
            });
        }
        // Without verified terminal evidence, old files alone cannot establish stalled work.
        if (typeof record.issue === 'number') task.issue = record.issue;
        if (typeof record.pr === 'string') task.pr = record.pr;
      } catch (error) {
        const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
        if (missing && workers.length && location.slot === 'orchestrator') continue;
        if (missing) task.summary = 'No legacy status record';
        else task.error = error instanceof Error ? error.message : 'Cannot read status';
      }
      fleet.tasks.push(task);
    }
  } catch (error) {
    fleet.error = error instanceof Error ? error.message : 'Cannot load Fleet configuration';
  }
  return fleet;
}

/** Revalidate a dispatch before reading its checkout or log; never trust a cached path. */
export function dashboardTaskSource(
  configFile: string,
  task: DashboardTask,
): { directory: string; log: string } {
  const config = loadFleetConfig(configFile);
  if (!task.dispatchId) {
    const directory = workflowSource(config, task.path);
    return { directory, log: join(directory, '.epic-worklog.md') };
  }
  const worker = readWorkerInventory(config.project).find(
    (w) =>
      w.dispatch_id === task.dispatchId && w.run_id === task.runId && w.fleet_id === task.fleetId,
  );
  if (!worker || worker.source !== task.source || worker.worktree !== task.path)
    throw new Error('Dispatch source changed');
  // Removed worktrees remain visible as historical records, but cannot be probed.
  const directory = workflowSourceDirectory(worker.worktree);
  return { directory, log: join(worker.source, '..', 'worker.log') };
}

function workflowSourceDirectory(path: string): string {
  if (!existsSync(path)) return path;
  const physical = realpathSync(path);
  if (physical !== path) throw new Error('Worker checkout must not be redirected');
  return physical;
}
