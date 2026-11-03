import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { DemoRounds, type DemoConfig } from '@paper-craft/core/workflow/demo';
import { nativeDemoAdapter } from '@paper-craft/core/workflow/demo-native';
import { DemoDisposition } from '@paper-craft/core/workflow/demo-disposition';
import { nativeDemoDisposal } from '@paper-craft/core/workflow/demo-disposal-native';
import { DemoVerifier } from '@paper-craft/core/workflow/demo-verifier';
/** Explicit eligibility inspection and owned disposal, separate from generic workflow reset. */
export function registerDemoDisposition(demo: Command) {
  demo
    .command('dispose <round>')
    .description(
      'Verify and explicitly dispose clean round; require fresh authorization for defective',
    )
    .option('--force-defective', 'Authorize cleanup of a defective or retained problem round')
    .option(
      '--authorized-by-fresh-round <round>',
      'Different independently verified fresh round using the same pinned baseline',
    )
    .action(async (id, o) => {
      if (o.forceDefective && !o.authorizedByFreshRound) {
        throw new Error(
          'Expected --authorized-by-fresh-round <round> when specifying --force-defective',
        );
      }
      if (o.authorizedByFreshRound && !o.forceDefective) {
        throw new Error('Expected --force-defective when specifying --authorized-by-fresh-round');
      }
      const config = JSON.parse(readFileSync(demo.opts().config, 'utf8')) as DemoConfig;
      const rounds = new DemoRounds(config, nativeDemoAdapter());
      const disposition = new DemoDisposition(
        nativeDemoDisposal(new DemoVerifier(), (r) => console.log(JSON.stringify(r, null, 2))),
      );
      const authorization =
        o.forceDefective && o.authorizedByFreshRound
          ? { fresh: rounds.status(o.authorizedByFreshRound), forceDefective: true }
          : undefined;
      console.log(JSON.stringify(await disposition.finish(rounds.status(id), authorization)));
    });
}
