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
    .description('Inspect independent evidence without side effects, release, or disposal')
    .option('--boundary <stage>', 'Stage boundary label', 'final')
    .action(async (id, options) => {
      const config = JSON.parse(readFileSync(demo.opts().config, 'utf8'));
      const round = new DemoRounds(config, nativeDemoAdapter()).status(id);
      const verifier = new DemoVerifier(nativeDemoEvidence({ chronology: demoChronology }));
      const result = await verifier.verify(round, options.boundary);
      console.log(JSON.stringify(result, null, 2));
    });
}
