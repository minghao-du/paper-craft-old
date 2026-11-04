/** Detached adapter entry: reconcile startup only, never schedule scientific/business work. */
import { loadFleetConfig } from '@paper-craft/core/workflow/fleet-config';
import { inspectRuns } from '@paper-craft/core/workflow/run-observation';
import { superviseStartup } from '@paper-craft/core/workflow/startup';
import { createRunner } from './composition.js';

const config = loadFleetConfig(process.argv[2]);
const runId = process.argv[3];
const run = inspectRuns(config).runs.find((r) => r.id === runId);
if (!run) throw new Error('Unknown startup Run');
const runner = createRunner(run.provider);

await superviseStartup(config, runner, runId);
