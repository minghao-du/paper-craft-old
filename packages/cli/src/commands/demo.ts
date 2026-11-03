import { registerDemoFinalization } from './demo-finalization.js';
import { registerDemoDisposition } from './demo-disposition.js';
import { registerDemoDelivery } from './demo-delivery.js';
import { registerDemoVerifier } from './demo-verifier.js';
import { DemoControl } from '@paper-craft/core/workflow/demo-control';
import { nativeDemoExecution } from '@paper-craft/core/workflow/demo-execution';
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { DemoRounds, type DemoConfig } from '@paper-craft/core/workflow/demo';
import { nativeDemoAdapter } from '@paper-craft/core/workflow/demo-native';
/** Opt-in disposable Agy demo round controls; no agents start during provisioning. */
export function registerDemoCommands(program: Command) {
  const demo = program
    .command('demo')
    .description('Explicit opt-in disposable Agy EPIC round')
    .requiredOption(
      '--config <file>',
      'Demo JSON: physical root, owner, prefix, coordinator, brief',
    );
  registerDemoVerifier(demo);
  registerDemoDisposition(demo);
  registerDemoDelivery(demo);
  registerDemoFinalization(demo);
  const controller = () =>
    new DemoRounds(
      JSON.parse(readFileSync(demo.opts().config, 'utf8')) as DemoConfig,
      nativeDemoAdapter(),
    );
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  demo
    .command('preflight')
    .description('Read-only prerequisites and intended writes')
    .action(async () => print(await controller().preflight()));
  demo
    .command('provision')
    .description('Create fresh disposable repository and initial EPIC; no agents')
    .option('--confirm', 'Confirm reviewed preflight write scope')
    .action(async (options) => {
      print(await controller().preflight());
      print(await controller().provision(options.confirm === true));
    });
  demo
    .command('status <round>')
    .description('Reconnect to persisted round identity')
    .action((id) => {
      const round = controller().status(id);
      print({ round, control: new DemoControl(round, nativeDemoExecution()).status() });
    });
  const control = (id: string) => new DemoControl(controller().status(id), nativeDemoExecution());
  demo
    .command('start <round>')
    .description('Explicitly start independent managed Agy Orchestrator')
    .option('--confirm', 'Confirm Agy execution')
    .option('--budget-minutes <minutes>', 'Active execution budget', '60')
    .action(async (id, o) =>
      print(await control(id).start(o.confirm === true, Number(o.budgetMinutes) * 60000)),
    );
  demo
    .command('report <round> <text>')
    .description('Retain a suspected problem without proof')
    .option('--evidence <reference>')
    .action((id, text, o) => print(control(id).report(text, o.evidence)));
  demo
    .command('resolve-observation <round> <observation> <reason>')
    .description('Record a reasoned false-alarm disposition')
    .action((id, observation, reason) => print(control(id).resolve(observation, reason)));
  demo
    .command('stop <round>')
    .description('Revoke dispatch and request verified termination; retain evidence')
    .action(async (id) => print(await control(id).stop()));
}
