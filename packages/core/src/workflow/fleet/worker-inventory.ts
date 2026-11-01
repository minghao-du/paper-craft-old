/** Read-only inventory shared by worker status and Dashboard. */
import { assertWorkflowRole, type WorkflowRole } from './workflow-role.js';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** One durable dispatch; in-flight is not proof of a live process. */
export interface WorkerAttempt {
  fleet_id: string;
  run_id: string;
  dispatch_id: string;
  issue_id: number;
  role: WorkflowRole;
  state: string;
  handled: boolean;
  receipt_path: string;
  receipt: string | null;
  handledPath: string;
  source: string;
  worktree: string;
  modifiedAt: string;
}

/** Reject redirected evidence and read only bounded regular files. */
export function workerEvidence(path: string): string {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.size > 256 * 1024)
    throw new Error(`Expected bounded regular worker evidence: ${path}`);
  return readFileSync(path, 'utf8');
}

/** Discover file-backed dispatches without launching, acknowledging or changing workers. */
export function readWorkerInventory(root: string, fleet?: string, runId?: string): WorkerAttempt[] {
  const runtime = join(realpathSync(root), '.runtime');
  const directories = (path: string): string[] => {
    try {
      if (!lstatSync(path).isDirectory() || realpathSync(path) !== path)
        throw new Error(`Runtime directory must not be redirected: ${path}`);
      return readdirSync(path, { withFileTypes: true })
        .filter((x) => x.isDirectory())
        .map((x) => x.name)
        .sort();
    } catch (error) {
      if (!runId && error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
  };
  const fleets = directories(runtime);
  const attempts: WorkerAttempt[] = [];
  for (const fleetId of fleet ? [fleet] : fleets) {
    if (fleet && !fleets.includes(fleet)) continue;
    const runs = join(runtime, fleetId, 'runs');
    const ids = directories(runs);
    for (const id of runId ? [runId] : ids) {
      const home = join(runs, id);
      directories(home);
      const record = JSON.parse(workerEvidence(join(home, 'run.json')));
      if (record.run_id !== id) throw new Error(`Run identifier mismatch: ${id}`);
      const dispatches = join(home, 'dispatches');
      if (!existsSync(dispatches)) continue;
      for (const dispatchId of directories(dispatches)) {
        const dir = join(dispatches, dispatchId);
        directories(dir);
        const source = join(dir, 'dispatch.json');
        const dispatch = JSON.parse(workerEvidence(source));
        if (dispatch.dispatch_id !== dispatchId || dispatch.run_id !== id)
          throw new Error(`Dispatch identifier mismatch: ${dispatchId}`);
        assertWorkflowRole(dispatch.role, source);
        const receiptPath = join(dir, 'RECEIPT.md');
        const receipt = existsSync(receiptPath) ? workerEvidence(receiptPath) : null;
        const handledPath = join(dir, 'HANDLED.json');
        const expected = join(runtime, fleetId, 'worktrees', dispatchId);
        if (dispatch.worktree !== undefined && dispatch.worktree !== expected)
          throw new Error(`Worktree path mismatch: ${dispatchId}`);
        attempts.push({
          fleet_id: fleetId,
          run_id: id,
          dispatch_id: dispatchId,
          issue_id: dispatch.issue_id,
          role: dispatch.role,
          state:
            receipt !== null
              ? 'completed'
              : existsSync(join(dir, 'EXIT.json'))
                ? 'exited-without-receipt'
                : 'in-flight',
          handled: existsSync(handledPath),
          receipt_path: receiptPath,
          receipt,
          handledPath,
          source,
          worktree: expected,
          modifiedAt: statSync(receipt !== null ? receiptPath : source).mtime.toISOString(),
        });
      }
    }
  }
  return attempts;
}
