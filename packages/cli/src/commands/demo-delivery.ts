import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { DemoRounds } from '@paper-craft/core/workflow/demo';
import { nativeDemoAdapter } from '@paper-craft/core/workflow/demo-native';
import { DemoDelivery } from '@paper-craft/core/workflow/demo-delivery';
import { nativeDemoDelivery } from '@paper-craft/core/workflow/demo-delivery-native';
import { DemoControl } from '@paper-craft/core/workflow/demo-control';
import { nativeDemoExecution } from '@paper-craft/core/workflow/demo-execution';
/** Human controls persist version-bound consent; business gates belong to the Orchestrator. */
export function registerDemoDelivery(demo: Command) {
  const service = (id: string, authority?: string, dispatch?: string) => {
    const round = new DemoRounds(
      JSON.parse(readFileSync(demo.opts().config, 'utf8')),
      nativeDemoAdapter(),
    ).status(id);
    return {
      round,
      delivery: new DemoDelivery(round, nativeDemoDelivery(round, authority, dispatch)),
      control: new DemoControl(round, nativeDemoExecution()),
    };
  };
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  demo
    .command('gate <round> <stage>')
    .description('Orchestrator checks worker1/worker2 prerequisites and authorizes worker dispatch')
    .option('--stage-name <name>', 'Worker stage name to authorize (default: implementation)')
    .option('--brief <file>', 'Evaluated task brief file')
    .option('--input-revision <rev>', 'Proposed task input revision')
    .action(async (id, stage, o) => {
      if (!['worker1', 'worker2'].includes(stage)) throw new Error('Expected worker1 or worker2');
      const brief = o.brief ? readFileSync(o.brief, 'utf8') : undefined;
      print(
        await service(id).delivery.gate(stage, {
          stageName: o.stageName,
          brief,
          inputRevision: o.inputRevision,
        }),
      );
    });
  demo
    .command('closure-request <round>')
    .description('Show integrated delivery version and pause active budget for human judgment')
    .action(async (id) => {
      const s = service(id);
      const facts = await s.delivery.request();
      print(facts);
      await s.control.humanWait(`Closure request for round ${id} delivery version ${facts.version}`);
    });
  demo
    .command('confirm <round> <version>')
    .description('Human confirms this exact requested delivery version')
    .option('--confirm', 'Explicit human closure confirmation')
    .action(async (id, version, o) => {
      const s = service(id);
      print(await s.delivery.confirm(version, o.confirm === true));
      if (s.control.status().wait === 'human') {
        await s.control.humanResume();
      }
    });
}
