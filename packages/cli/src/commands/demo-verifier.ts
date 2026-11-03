import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { DemoRounds } from '@paper-craft/core/workflow/demo';
import { nativeDemoAdapter } from '@paper-craft/core/workflow/demo-native';
import { DemoVerifier } from '@paper-craft/core/workflow/demo-verifier';
/** Independent read-only external inspection, with local retained diagnostic history. */
export function registerDemoVerifier(demo: Command) {
  demo
    .command('verify <round>')
    .description('Independently inspect GitHub/Git/runtime evidence; preserve diagnostics')
    .option('--boundary <stage>', 'Stage boundary label', 'final')
    .action(async (id, options) => {
      const config = JSON.parse(readFileSync(demo.opts().config, 'utf8'));
      const round = new DemoRounds(config, nativeDemoAdapter()).status(id);
      console.log(
        JSON.stringify(await new DemoVerifier().verify(round, options.boundary), null, 2),
      );
    });
}
