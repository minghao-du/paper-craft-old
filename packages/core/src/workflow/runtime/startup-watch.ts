/** Detached adapter entry: reconcile startup only, never schedule scientific/business work. */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadFleetConfig } from '../fleet/fleet-config.js';
import { managedRunner } from './runtime.js';
import { inspectRuns } from '../run/run-driver.js';
import { claimDriver } from '../run/driver-lock.js';
import { ensureStartupRecovery, reconcileStartup, startupDirectory } from '../run/startup.js';

const config = loadFleetConfig(process.argv[2]);
const runId = process.argv[3];
const run = inspectRuns(config).runs.find((r) => r.id === runId);
if (!run) throw new Error('Unknown startup Run');
const runner = managedRunner(run.provider);
const lock = join(startupDirectory(config, runId), 'startup.lock');
let owned = false;
let stopped = false;
process.on('SIGTERM', () => {
  stopped = true;
});
process.on('SIGINT', () => {
  stopped = true;
});
try {
  claimDriver(lock);
  owned = true;
  while (!stopped) {
    try {
      if (!(await reconcileStartup(config, runner, runId))) break;
    } catch (error) {
      console.error(new Date().toISOString(), String(error));
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
} catch (error) {
  if (owned) throw error;
} finally {
  if (owned) {
    rmSync(lock, { recursive: true, force: true });
    // Release ownership before checking again: a concurrent dispatch cannot lose its wake-up.
    if (!stopped) ensureStartupRecovery(config, runner, runId);
  }
}
