/** Demo-only disposal; verification is recollected, never accepted from a report supplied by callers. */
import { existsSync, readFileSync, writeFileSync, realpathSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DemoRound, DemoRepository } from './round.js';
import type { DemoVerification } from './verifier.js';
/** External facts and deletion boundary, replaced only for offline contract tests. */
export interface DemoDisposalAdapter {
  verify(round: DemoRound): Promise<DemoVerification>;
  released(round: DemoRound): Promise<boolean>;
  repository(round: DemoRound): Promise<DemoRepository | null>;
  removeRepository(round: DemoRound): Promise<void>;
  removeLocal(round: DemoRound): Promise<void>;
  display(result: DemoVerification): void;
}
/** Disposable scenes are retained until all independent dimensions and ownership gates pass. */
export class DemoDisposition {
  constructor(readonly adapter: DemoDisposalAdapter) {}
  /** Clean rounds auto-dispose; retained problems require a different verified round and explicit consent. */
  async finish(round: DemoRound, authorization?: { fresh: DemoRound; confirmed: boolean }) {
    const record = join(round.root, 'disposition.json');
    const retain = (cleanup: 'retained' | 'failed', reason: string) => {
      const result = { cleanup, reason, success: false };
      writeFileSync(record, JSON.stringify(result));
      return result;
    };
    const lock = join(round.root, 'disposal.lock');
    mkdirSync(lock);
    try {
      const owned = () => {
        if (
          round.ownershipUncertain ||
          realpathSync(round.root) !== round.root ||
          round.root !== join(round.config.root, round.id)
        )
          throw new Error('Uncertain or mismatched physical round ownership');
        const stored: DemoRound = JSON.parse(readFileSync(join(round.root, 'round.json'), 'utf8'));
        if (
          stored.id !== round.id ||
          JSON.stringify(stored.repository) !== JSON.stringify(round.repository) ||
          stored.config.root !== round.config.root ||
          !round.repository ||
          round.repository.owner !== round.config.owner ||
          round.repository.name !== round.config.prefix + round.id
        )
          throw new Error('Repository ownership mismatch');
      };
      const observations = () => {
        const p = join(round.root, 'control.json');
        if (!existsSync(p)) return true;
        const c = JSON.parse(readFileSync(p, 'utf8'));
        return (
          !c.stopped &&
          (c.observations ?? []).every(
            (o: { disposition?: { status: string; reason: string } }) =>
              o.disposition?.status === 'false_alarm' && o.disposition.reason.trim(),
          )
        );
      };
      owned();
      await this.adapter.released(round);
      const result = await this.adapter.verify(round);
      const clean = (r: DemoVerification) =>
        r.business === 'completed' &&
        r.defects === 'clear' &&
        r.execution === 'released' &&
        r.cleanup !== 'failed';
      const old = existsSync(record);
      let authorized = false;
      if (authorization?.confirmed) {
        const fresh = authorization.fresh;
        if (
          fresh.id === round.id ||
          fresh.repository?.id === round.repository?.id ||
          fresh.baseline !== round.baseline
        )
          throw new Error('Expected different fresh validation round with equivalent baseline');
        authorized = clean(await this.adapter.verify(fresh));
      }
      if ((old || !clean(result) || !observations()) && !authorized)
        return retain(
          'retained',
          'Problems require fresh validation and explicit deletion confirmation',
        );
      if (!(await this.adapter.released(round)))
        return retain('retained', 'Execution or helper occupancy unknown');
      const journal = () =>
        existsSync(join(round.root, 'control.json'))
          ? readFileSync(join(round.root, 'control.json'), 'utf8')
          : '';
      const observedJournal = journal();
      this.adapter.display(result);
      if (journal() !== observedJournal)
        return retain('retained', 'Observation journal changed during disposal');
      if (!authorized && !observations())
        return retain('retained', 'Late unresolved observation or user stop');
      owned();
      const identity = await this.adapter.repository(round);
      if (identity && JSON.stringify(identity) !== JSON.stringify(round.repository))
        throw new Error('Remote repository identity changed');
      if (identity) {
        try {
          await this.adapter.removeRepository(round);
        } catch (error) {
          // Reconcile before another mutation; even an absent repository preserves the failure diagnosis.
          const remaining = await this.adapter.repository(round);
          return retain(
            'failed',
            `Repository deletion uncertain: ${String(error)}; remaining=${JSON.stringify(remaining)}`,
          );
        }
        if (await this.adapter.repository(round))
          return retain('failed', 'Repository still exists after deletion');
      }
      if (journal() !== observedJournal)
        return retain(
          'failed',
          'Observation journal changed after remote deletion; local evidence retained',
        );
      await this.adapter.removeLocal(round);
      return {
        cleanup: 'completed' as const,
        success: clean(result),
        reason: 'Owned disposable resources removed',
      };
    } catch (error) {
      return retain('failed', String(error));
    } finally {
      if (existsSync(lock)) rmSync(lock, { recursive: true });
    }
  }
}
