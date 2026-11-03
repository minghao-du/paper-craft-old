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
    .action((id) => print(controller().status(id)));
}
