import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
/** Native Agy adapter: no provider fallback and no invented release receipts. */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { loadFleetConfig } from '../fleet/fleet-config.js';
import { inspectRuns } from '../run/run-registry.js';
import { stopRun, releaseRun } from '../run/run-control.js';
import type { RunnerAdapter } from '../runtime/runtime.js';
import type { DemoExecution } from './control.js';

let demoRunnerResolver: ((provider: string) => RunnerAdapter) | undefined;

/** Set host runner resolver for demo execution stop/release. */
export function setDemoRunnerResolver(
  resolver: ((provider: string) => RunnerAdapter) | undefined,
): void {
  demoRunnerResolver = resolver;
}

/** Existing managed Runtime owns startup, detached recovery and termination evidence. */
export function nativeDemoExecution(
  resolveRunner?: (provider: string) => RunnerAdapter,
): DemoExecution {
  return {
    watch(round) {
      const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
      const loaderArgs: string[] = [];
      for (let i = 0; i < process.execArgv.length; i++) {
        const a = process.execArgv[i];
        if (/^--(import|require|loader|conditions)(=|$)/.test(a)) {
          loaderArgs.push(a);
          if (!a.includes('=')) loaderArgs.push(process.execArgv[++i]);
        }
      }
      const child = spawn(
        process.execPath,
        [...loaderArgs, fileURLToPath(new URL('./watch' + extension, import.meta.url)), round.root],
        { detached: true, stdio: 'ignore' },
      );
      child.on('error', (e) => writeFileSync(join(round.root, 'watch-error.txt'), String(e)));
      writeFileSync(
        join(round.root, 'watch.json'),
        JSON.stringify({ pid: child.pid, round: round.id }),
      );
      child.unref();
    },
    async stop(round, runId, completed = false) {
      if (!runId) return true;
      const config = loadFleetConfig(join(round.checkout, '.epic-config.json'));
      const resolver = resolveRunner ?? demoRunnerResolver;
      if (!resolver) throw new Error('Runner resolver required for nativeDemoExecution.stop');
      const run = inspectRuns(config).runs.find((r) => r.id === runId);
      if (!run) return true;
      const runner = resolver(run.provider);
      if (completed) {
        const res = await releaseRun(config, runner, runId);
        return res.released;
      }
      const res = await stopRun(config, runner, runId);
      return res.terminated;
    },
  };
}
