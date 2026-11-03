import { DemoDisposition } from '@paper-craft/core/workflow/demo-disposition';
import { nativeDemoDisposal } from '@paper-craft/core/workflow/demo-disposal-native';
import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { DemoRounds } from '@paper-craft/core/workflow/demo';
import { nativeDemoAdapter } from '@paper-craft/core/workflow/demo-native';
import { demoChronology } from '@paper-craft/core/workflow/demo-delivery';
import { nativeDemoEvidence, DemoVerifier } from '@paper-craft/core/workflow/demo-verifier';
/** Independent read-only external inspection, with local retained diagnostic history. */
export function registerDemoVerifier(demo: Command) {
  demo
    .command('verify <round>')
    .description(
      'Inspect independent evidence; final check releases and auto-disposes clean scenes',
    )
    .option('--boundary <stage>', 'Stage boundary label', 'final')
    .action(async (id, options) => {
      const config = JSON.parse(readFileSync(demo.opts().config, 'utf8'));
      const round = new DemoRounds(config, nativeDemoAdapter()).status(id);
      const verifier = new DemoVerifier(nativeDemoEvidence({ chronology: demoChronology }));
      if (options.boundary === 'final') {
        const disposition = new DemoDisposition(
          nativeDemoDisposal(verifier, (result) => console.log(JSON.stringify(result, null, 2))),
        );
        console.log(JSON.stringify(await disposition.finish(round)));
        return;
      }
      console.log(JSON.stringify(await verifier.verify(round, options.boundary), null, 2));
    });
}
