import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
/** Native Agy adapter: no provider fallback and no invented release receipts. */
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { loadFleetConfig } from '../fleet/fleet-config.js';
import { startupRecoveryStatus } from '../runtime/startup-supervisor.js';
import { startRun, inspectRuns, updateRunRegistry } from '../run/run-driver.js';
import { managedRunner, cancelAttempt, reconcileAttempt } from '../runtime/runtime.js';
import type { DemoExecution } from './control.js';
/** Existing managed Runtime owns startup, detached recovery and termination evidence. */
export function nativeDemoExecution(): DemoExecution {
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
    async start(round) {
      if (
        round.phase !== 'provisioned' ||
        round.ownershipUncertain ||
        !round.repository ||
        !round.parent
      )
        throw new Error('Expected fully owned provisioned round');
      const config = loadFleetConfig(join(round.checkout, '.epic-config.json'));
      const repository = round.repository.owner + '/' + round.repository.name;
      const issue = JSON.parse(
        execFileSync(
          'gh',
          ['issue', 'view', String(round.parent), '--repo', repository, '--json', 'title,body'],
          { encoding: 'utf8' },
        ),
      );
      const run = await startRun(
        config,
        managedRunner('agy'),
        { repository, number: round.parent, title: issue.title, body: issue.body, kind: 'epic' },
        'agy',
        `Diagnostic demo round ${round.id}. Agy only. Exactly two native dependent child tasks and two PRs. Never retry failures or repair defects. Preserve every failed stage. Coordinator ${round.config.coordinator}; report entry ${round.entry}. ${round.config.brief}`,
      );
      return run.id;
    },
    async stop(round, runId, completed = false) {
      const config = loadFleetConfig(join(round.checkout, '.epic-config.json'));
      const snapshot = inspectRuns(config);
      const run = snapshot.runs.find((r) => r.id === runId);
      if (!run) return false;
      if (completed && run.lifecycle !== 'completed') return false;
      // Revoke scheduling authority before terminating any execution.
      if (!completed)
        updateRunRegistry(config, (r) => {
          r.runs.find((x) => x.id === run.id)!.lifecycle = 'blocked';
        });
      const attempts = [
        ...(run.priorOrchestrators ?? []),
        ...(run.orchestrator ? [run.orchestrator] : []),
        ...(snapshot.dispatches ?? []).filter((d) => d.runId === run.id).flatMap((d) => d.attempts),
      ];
      const runner = managedRunner('agy');
      let terminated = attempts.length > 0;
      for (const a of attempts) {
        if (a.runner !== 'agy') {
          terminated = false;
          continue;
        }
        if (!(await runner.stopped(a))) await cancelAttempt(a, runner);
        if (!(await runner.stopped(a))) terminated = false;
        else await reconcileAttempt(a, { termination: runner.stopped.bind(runner) });
      }
      // A stopped process alone cannot release checkout, helper or driver ownership.
      return (
        terminated &&
        !(snapshot.resources ?? []).some((r) => r.runId === run.id) &&
        !startupRecoveryStatus(config, run.id).active &&
        existsSync(join(round.root, 'watch-exit.json')) &&
        JSON.parse(readFileSync(join(round.root, 'watch-exit.json'), 'utf8')).pid ===
          JSON.parse(readFileSync(join(round.root, 'watch.json'), 'utf8')).pid
      );
    },
  };
}
