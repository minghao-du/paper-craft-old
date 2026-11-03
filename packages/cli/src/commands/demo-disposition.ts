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
    .description('Verify and auto-dispose clean round; retain problems')
    .option('--validated-by <round>', 'Fresh independent validation round for retained problems')
    .option('--confirm-resolved', 'Confirm findings resolved and authorize retained-scene deletion')
    .action(async (id, o) => {
      const config = JSON.parse(readFileSync(demo.opts().config, 'utf8')) as DemoConfig;
      const rounds = new DemoRounds(config, nativeDemoAdapter());
      const disposition = new DemoDisposition(
        nativeDemoDisposal(new DemoVerifier(), (r) => console.log(JSON.stringify(r, null, 2))),
      );
      console.log(
        JSON.stringify(
          await disposition.finish(
            rounds.status(id),
            o.validatedBy
              ? { fresh: rounds.status(o.validatedBy), confirmed: o.confirmResolved === true }
              : undefined,
          ),
        ),
      );
    });
}
