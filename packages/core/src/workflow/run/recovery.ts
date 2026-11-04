/** Batch recovery delegates authority and evidence reconciliation to each Run. */
import type { FleetConfig } from '../fleet/fleet-config.js';
import type { RunnerAdapter } from '../runtime/runtime.js';
import { inspectRuns, recoverRun } from './run-driver.js';

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
