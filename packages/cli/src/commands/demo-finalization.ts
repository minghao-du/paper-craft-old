import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { DemoRounds } from '@paper-craft/core/workflow/demo';
import { nativeDemoAdapter } from '@paper-craft/core/workflow/demo-native';
import {
  DemoFinalization,
  nativeDemoFinalization,
} from '@paper-craft/core/workflow/demo-finalization';
/** Orchestrator invokes normal post-closure gates after real accepted specialists. */
export function registerDemoFinalization(demo: Command) {
  for (const operation of ['pipeline', 'publish'] as const)
    demo
      .command(`${operation} <round>`)
      .description(
        operation === 'pipeline'
          ? 'Verify real no-change Pipeline audit after actual closure'
          : 'Publish accepted Research-State report into isolated destination',
      )
      .requiredOption('--authority <attempt>', 'Active managed Orchestrator authority')
      .requiredOption('--dispatch <id>', 'Accepted specialist Dispatch')
      .action(async (id, options) => {
        const round = new DemoRounds(
          JSON.parse(readFileSync(demo.opts().config, 'utf8')),
          nativeDemoAdapter(),
        ).status(id);
        const service = new DemoFinalization(
          round,
          nativeDemoFinalization(round, options.authority, options.dispatch),
        );
        console.log(JSON.stringify(await service[operation](), null, 2));
      });
}
