import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { DemoRounds, type DemoConfig } from '@paper-craft/core/workflow/demo';
import { nativeDemoAdapter } from '@paper-craft/core/workflow/demo-native';
import {
  DemoFinalization,
  nativeDemoFinalization,
} from '@paper-craft/core/workflow/demo-finalization';

/** Public finalization views needed for Demo observation. */
export function registerDemoFinalization(demo: Command) {
  demo
    .command('finalization <round>')
    .description('Inspect durable post-closure finalization and publication status for a Demo round')
    .action(async (id) => {
      const config = JSON.parse(readFileSync(demo.opts().config, 'utf8')) as DemoConfig;
      const round = new DemoRounds(config, nativeDemoAdapter()).status(id);
      const service = new DemoFinalization(round, nativeDemoFinalization(round));
      console.log(JSON.stringify(await service.view(), null, 2));
    });
}
