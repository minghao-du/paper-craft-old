import { inspectRuns } from '../run/run-driver.js';
import { loadFleetConfig } from '../fleet/fleet-config.js';
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
    async released(round) {
      const config = loadFleetConfig(join(round.checkout, '.epic-config.json'));
      const state = new DemoControl(round, nativeDemoExecution()).status();
      if (inspectRuns(config).runs.find((r) => r.id === state.runId)?.lifecycle !== 'completed')
        return (
          (await new DemoControl(round, nativeDemoExecution()).stop()).execution === 'released'
        );
      if ((await new DemoControl(round, nativeDemoExecution()).release()).execution !== 'released')
        return false;
      if ((await verifier.verify(round)).execution !== 'released') return false;
      const watch = join(round.root, 'watch.json'),
        exit = join(round.root, 'watch-exit.json');
      if (!existsSync(watch) || !existsSync(exit)) return false;
      return (
        JSON.parse(readFileSync(watch, 'utf8')).pid === JSON.parse(readFileSync(exit, 'utf8')).pid
      );
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
