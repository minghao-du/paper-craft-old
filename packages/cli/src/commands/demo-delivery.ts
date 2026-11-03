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
    .description('Orchestrator checks worker1/worker2 prerequisites before dispatch')
    .action(async (id, stage) => {
      if (!['worker1', 'worker2'].includes(stage)) throw new Error('Expected worker1 or worker2');
      print(await service(id).delivery.gate(stage));
    });
  demo
    .command('closure-request <round>')
    .description('Show integrated delivery version and pause active budget for human judgment')
    .action(async (id) => {
      const s = service(id);
      print(await s.delivery.request());
      await s.control.checkpoint('human');
    });
  demo
    .command('confirm <round> <version>')
    .description('Human confirms this exact requested delivery version')
    .option('--confirm', 'Explicit human closure confirmation')
    .action(async (id, version, o) => {
      const s = service(id);
      print(await s.delivery.confirm(version, o.confirm === true));
      await s.control.checkpoint();
    });
  demo
    .command('close <round>')
    .description('Orchestrator actually closes Parent and invokes existing closure verification')
    .requiredOption('--authority <attempt>', 'Active managed Orchestrator authority')
    .requiredOption('--dispatch <id>', 'Accepted integrated acceptance Dispatch')
    .action(async (id, o) => {
      await service(id, o.authority, o.dispatch).delivery.close();
      print({ closed: true });
    });
}
