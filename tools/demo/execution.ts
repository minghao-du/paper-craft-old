/** Native Agy adapter: no provider fallback and no invented release receipts. */
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { loadFleetConfig } from '@paper-craft/core/workflow/fleet-config';
import { inspectRuns } from '@paper-craft/core/workflow/run-driver';
import { inspectRun } from '@paper-craft/core/workflow/run-observation';
import { stopRun, releaseRun } from '@paper-craft/core/workflow/run-control';
import type { RunnerAdapter } from '@paper-craft/core/workflow/runtime';
import type { DemoExecution } from './control.js';

let demoRunnerResolver: ((provider: string) => RunnerAdapter) | undefined;

/** Set runner resolver for in-process test execution. */
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
      const configPath = join(round.checkout, '.epic-config.json');
      if (!existsSync(configPath)) return true;
      const config = loadFleetConfig(configPath);
      const resolver = resolveRunner ?? demoRunnerResolver;
      if (resolver) {
        const run = inspectRuns(config).runs.find((r) => r.id === runId);
        if (!run) return true;
        const runner = resolver(run.provider);
        if (completed) {
          const res = await releaseRun(config, runner, runId);
          return res.released;
        }
        const res = await stopRun(config, runner, runId);
        return res.terminated;
      }

      // CLI fallback: invoke product CLI to stop/release
      const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
      const pcBin = join(repoRoot, 'pc');
      try {
        execFileSync(
          pcBin,
          ['workflow', 'orchestrator', completed ? 'release' : 'stop', runId, '--config', configPath],
          { stdio: 'pipe', encoding: 'utf8' },
        );
      } catch {
        // CLI exit code may be 2 if warnings/blockers, verify actual state below
      }

      try {
        const view = inspectRun(config, runId);
        return completed ? view.released : view.terminated;
      } catch {
        return true;
      }
    },
  };
}
