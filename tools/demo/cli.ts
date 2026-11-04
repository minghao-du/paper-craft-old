#!/usr/bin/env node
/**
 * Developer tool CLI for disposable Agy demo scenarios.
 * For maintainers and internal evaluation; not a public product command.
 */
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { DemoRounds, type DemoConfig } from './round.js';
import { nativeDemoAdapter } from './native.js';
import { DemoControl } from './control.js';
import { nativeDemoExecution } from './execution.js';
import { DemoDelivery, demoChronology } from './delivery.js';
import { nativeDemoDelivery } from './delivery-native.js';
import { DemoVerifier, nativeDemoEvidence } from './verifier.js';
import { DemoFinalization, nativeDemoFinalization } from './finalization.js';
import { DemoDisposition } from './disposition.js';
import { nativeDemoDisposal } from './disposal-native.js';

/** Create and configure the developer-only demo CLI command tree. */
export function createDemoProgram(): Command {
  const program = new Command('demo')
    .description('Explicit opt-in disposable Agy EPIC round developer tool')
    .requiredOption(
      '--config <file>',
      'Demo JSON: physical root, owner, prefix, coordinator, brief',
    );

  const controller = () =>
    new DemoRounds(
      JSON.parse(readFileSync(program.opts().config, 'utf8')) as DemoConfig,
      nativeDemoAdapter(),
    );
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

  const control = (id: string) =>
    new DemoControl(controller().status(id), nativeDemoExecution());

  const deliveryService = (id: string) => {
    const round = controller().status(id);
    return {
      round,
      delivery: new DemoDelivery(round, nativeDemoDelivery(round)),
      control: new DemoControl(round, nativeDemoExecution()),
    };
  };

  program
    .command('preflight')
    .description('Read-only prerequisites and intended writes')
    .action(async () => print(await controller().preflight()));

  program
    .command('provision')
    .description('Create fresh disposable repository and initial EPIC; no agents')
    .option('--confirm', 'Confirm reviewed preflight write scope')
    .action(async (options) => {
      print(await controller().preflight());
      print(await controller().provision(options.confirm === true));
    });

  program
    .command('status <round>')
    .description('Reconnect to persisted round identity')
    .action((id) => {
      const round = controller().status(id);
      print({ round, control: new DemoControl(round, nativeDemoExecution()).status() });
    });

  program
    .command('arm <round>')
    .description('Arm budget accounting and detached watchdog for a fresh round')
    .option('--budget-minutes <minutes>', 'Active execution budget in minutes', '60')
    .action(async (id, o) =>
      print(await control(id).arm(Number(o.budgetMinutes) * 60000)),
    );

  program
    .command('report <round> <text>')
    .description('Retain a suspected problem without proof')
    .option('--evidence <reference>')
    .action((id, text, o) => print(control(id).report(text, o.evidence)));

  program
    .command('resolve-observation <round> <observation> <reason>')
    .description('Record a reasoned false-alarm disposition')
    .action((id, observation, reason) => print(control(id).resolve(observation, reason)));

  program
    .command('permission-wait <round> <evidence>')
    .description('Operator records an observed Agy permission prompt; pause active budget')
    .option('--confirm', 'Confirm observed native permission wait and evidence')
    .action(async (id, evidence, o) => {
      if (!o.confirm || !evidence.trim())
        throw new Error('Expected confirmed observed permission prompt and evidence');
      print(await control(id).permissionWait(evidence));
    });

  program
    .command('permission-resume <round>')
    .description('Operator confirms permission prompt resolved; resume permission budget pause')
    .option('--confirm', 'Confirm native permission prompt resolved')
    .action(async (id, o) => {
      if (!o.confirm) throw new Error('Expected explicit permission resolution');
      print(await control(id).permissionResume());
    });

  program
    .command('stop <round>')
    .description('Revoke dispatch and request verified termination; retain evidence')
    .action(async (id) => print(await control(id).stop()));

  // Delivery commands
  program
    .command('gate <round> <stage>')
    .description('Check worker1/worker2 prerequisites and authorize worker dispatch')
    .option('--stage-name <name>', 'Worker stage name to authorize (default: implementation)')
    .option('--brief <file>', 'Evaluated task brief file')
    .option('--input-revision <rev>', 'Proposed task input revision')
    .action(async (id, stage, o) => {
      if (!['worker1', 'worker2'].includes(stage)) throw new Error('Expected worker1 or worker2');
      const brief = o.brief ? readFileSync(o.brief, 'utf8') : undefined;
      print(
        await deliveryService(id).delivery.gate(stage, {
          stageName: o.stageName,
          brief,
          inputRevision: o.inputRevision,
        }),
      );
    });

  program
    .command('closure-request <round>')
    .description('Show integrated delivery version and pause active budget for human judgment')
    .action(async (id) => {
      const s = deliveryService(id);
      const facts = await s.delivery.request();
      print(facts);
      await s.control.humanWait(`Closure request for round ${id} delivery version ${facts.version}`);
    });

  program
    .command('confirm <round> <version>')
    .description('Human confirms this exact requested delivery version')
    .option('--confirm', 'Explicit human closure confirmation')
    .action(async (id, version, o) => {
      const s = deliveryService(id);
      print(await s.delivery.confirm(version, o.confirm === true));
      if (s.control.status().wait === 'human') {
        await s.control.humanResume();
      }
    });

  // Verifier command
  program
    .command('verify <round>')
    .description('Inspect independent evidence without side effects, release, or disposal')
    .option('--boundary <stage>', 'Stage boundary label', 'final')
    .action(async (id, options) => {
      const config = JSON.parse(readFileSync(program.opts().config, 'utf8'));
      const round = new DemoRounds(config, nativeDemoAdapter()).status(id);
      const verifier = new DemoVerifier(nativeDemoEvidence({ chronology: demoChronology }));
      const result = await verifier.verify(round, options.boundary);
      print(result);
    });

  // Finalization command
  program
    .command('finalization <round>')
    .description('Inspect durable post-closure finalization and publication status for a Demo round')
    .action(async (id) => {
      const config = JSON.parse(readFileSync(program.opts().config, 'utf8')) as DemoConfig;
      const round = new DemoRounds(config, nativeDemoAdapter()).status(id);
      const service = new DemoFinalization(round, nativeDemoFinalization(round));
      print(await service.view());
    });

  // Disposition command
  program
    .command('dispose <round>')
    .description(
      'Verify and explicitly dispose clean round; require fresh authorization for defective',
    )
    .option('--force-defective', 'Authorize cleanup of a defective or retained problem round')
    .option(
      '--authorized-by-fresh-round <round>',
      'Different independently verified fresh round using the same pinned baseline',
    )
    .action(async (id, o) => {
      if (o.forceDefective && !o.authorizedByFreshRound) {
        throw new Error(
          'Expected --authorized-by-fresh-round <round> when specifying --force-defective',
        );
      }
      if (o.authorizedByFreshRound && !o.forceDefective) {
        throw new Error('Expected --force-defective when specifying --authorized-by-fresh-round');
      }
      const config = JSON.parse(readFileSync(program.opts().config, 'utf8')) as DemoConfig;
      const rounds = new DemoRounds(config, nativeDemoAdapter());
      const disposition = new DemoDisposition(
        nativeDemoDisposal(new DemoVerifier(), (r) => console.log(JSON.stringify(r, null, 2))),
      );
      const authorization =
        o.forceDefective && o.authorizedByFreshRound
          ? { fresh: rounds.status(o.authorizedByFreshRound), forceDefective: true }
          : undefined;
      print(await disposition.finish(rounds.status(id), authorization));
    });

  return program;
}

if (process.argv[1] && (process.argv[1].endsWith('cli.ts') || process.argv[1].endsWith('cli.js'))) {
  createDemoProgram().parseAsync(process.argv);
}
