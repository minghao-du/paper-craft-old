import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
/** Native Agy adapter: no provider fallback and no invented release receipts. */
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { loadFleetConfig } from '../fleet/fleet-config.js';
import { startupRecoveryStatus } from '../runtime/startup-supervisor.js';
import { startRun, inspectRuns, updateRunRegistry } from '../run/run-driver.js';
import { managedRunner, cancelAttempt } from '../runtime/runtime.js';
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
      const demoConfigPath = join(round.root, 'demo-config.json');
      writeFileSync(demoConfigPath, JSON.stringify(round.config));
      const run = await startRun(
        config,
        managedRunner('agy'),
        { repository, number: round.parent, title: issue.title, body: issue.body, kind: 'epic' },
        'agy',
        `Diagnostic demo round ${round.id}. Read skills/pc-demo/SKILL.md from the paper-craft installation. Use pc demo --config ${demoConfigPath} gate ${round.id} worker1 before Worker1 and gate ${round.id} worker2 before Worker2 dispatch; failed gate stops the round. Exactly two native child Issues, second natively blocked by first. Workers deliver Python stdlib generator+test+TSV then reader+changed-input test+JSON. Complete Quality, merge, Final Records, preservation, cleanup and verified handover for each. Run independent boundary verification. After accepted integrated acceptance invoke closure-request ${round.id}, wait without polling for explicit human confirm, then close ${round.id} with your authority and accepted Dispatch. Never invent consent. After verified actual closure dispatch real Agy pipeline-audit for bounded applicability and structural inspection. Require inspectedVersions to include closure head and actual inspection evidence even for not_applicable/completed_no_changes. Use pc demo pipeline with authority and accepted specialist dispatch. changes_needed or defects stop and retain; never repair, create extra Issues or a third PR. Then dispatch real Agy research-state to write a short report artifact with all nine Research-State sections, actual commands/results, issue/PR references, accepted versus observed versions, values and limitations. Use pc demo publish with authority and accepted research Dispatch; it supplies operator Coordinator identity, isolated entry and confirmed brief to the existing transactional publication contract. Do not claim completion before verified provenance. Human report and stop remain available throughout specialists. Agy only. Exactly two native dependent child tasks and two PRs. Never retry failures or repair defects. Preserve every failed stage. Coordinator ${round.config.coordinator}; report entry ${round.entry}. ${round.config.brief}`,
      );
      return run.id;
    },
    async stop(round, runId) {
      const config = loadFleetConfig(join(round.checkout, '.epic-config.json'));
      const snapshot = inspectRuns(config);
      const run = snapshot.runs.find((r) => r.id === runId);
      if (!run) return false;
      // Revoke scheduling authority before terminating any execution.
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
