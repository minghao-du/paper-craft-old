import { inspectRuns, inspectRun } from '@paper-craft/core/workflow/run-observation';
import { loadFleetConfig } from '@paper-craft/core/workflow/fleet-config';
/** Native disposal only follows freshly collected verifier evidence and persisted identities. */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { DemoDisposalAdapter } from './disposition.js';
import { DemoControl } from './control.js';
import { nativeDemoExecution } from './execution.js';
import { DemoVerifier } from './verifier.js';
/** Supply the integrated independent verifier (including chronology and artifact readers). */
export function nativeDemoDisposal(
  verifier: DemoVerifier,
  display: DemoDisposalAdapter['display'],
): DemoDisposalAdapter {
  const gh = (args: string[]) =>
    execFileSync('gh', args, {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  return {
    verify: (round) => verifier.verify(round),
    display,
    async release(round) {
      const configPath = round.workflowConfigFile ?? join(round.checkout, '.epic-config.json');
      if (!existsSync(configPath)) return false;
      const config = loadFleetConfig(configPath);
      const state = new DemoControl(round, nativeDemoExecution()).status();
      const run = inspectRuns(config).runs.find((r) => r.id === state.runId);
      if (run && run.lifecycle === 'completed') {
        const res = await new DemoControl(round, nativeDemoExecution()).release();
        return res.execution === 'released';
      } else if (run) {
        const res = await new DemoControl(round, nativeDemoExecution()).stop();
        return res.execution === 'released';
      }
      return true;
    },
    async released(round) {
      const configPath = round.workflowConfigFile ?? join(round.checkout, '.epic-config.json');
      if (!existsSync(configPath)) return false;
      const config = loadFleetConfig(configPath);
      const state = new DemoControl(round, nativeDemoExecution()).status();
      if (state.execution !== 'released' || !state.runId) return false;
      let runView: ReturnType<typeof inspectRun>;
      try {
        runView = inspectRun(config, state.runId);
      } catch {
        return false;
      }
      if (runView.resources && runView.resources.length > 0) return false;
      if (runView.helper?.active) return false;
      if ((await verifier.verify(round)).execution !== 'released') return false;
      const watch = join(round.root, 'watch.json'),
        exit = join(round.root, 'watch-exit.json');
      if (existsSync(watch) && !existsSync(exit)) return false;
      if (existsSync(watch) && existsSync(exit)) {
        try {
          if (
            JSON.parse(readFileSync(watch, 'utf8')).pid !==
            JSON.parse(readFileSync(exit, 'utf8')).pid
          )
            return false;
        } catch {
          return false;
        }
      }
      return true;
    },
    async repository(round) {
      try {
        const r = JSON.parse(
          gh(['api', `repos/${round.repository!.owner}/${round.repository!.name}`]),
        );
        return { id: r.id, owner: r.owner.login, name: r.name };
      } catch (error) {
        if (String(error).includes('HTTP 404')) return null;
        throw error;
      }
    },
    async removeRepository(round, beforeDelete) {
      await setTimeout(1100);
      beforeDelete?.();
      gh([
        'api',
        '--method',
        'DELETE',
        `repos/${round.repository!.owner}/${round.repository!.name}`,
      ]);
    },
    async removeLocal(round) {
      if (
        realpathSync(round.root) !== round.root ||
        round.root !== join(round.config.root, round.id)
      )
        throw new Error('Physical round root changed');
      rmSync(round.root, { recursive: true });
    },
  };
}
