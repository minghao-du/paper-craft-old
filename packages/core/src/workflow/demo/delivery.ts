/** Demo boundary checks and human consent; business assignments remain Orchestrator decisions. */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectRuns } from '../run/run-driver.js';
import { loadFleetConfig } from '../fleet/fleet-config.js';
import type { DemoRound } from './round.js';
/** Independently observed current delivery, never an agent's asserted result. */
export interface DemoDeliverySnapshot {
  version: string;
  children: number[];
  nativeDependency: boolean;
  firstReleased: boolean;
  secondBaseline: boolean;
  accepted: boolean;
}
/** External GitHub/Runtime facts; controlled adapters cannot establish live acceptance. */
export interface DemoDeliveryAdapter {
  inspect(): Promise<DemoDeliverySnapshot>;
  close(confirmation: {
    deliveryVersion: string;
    source: 'human';
    evidence: string;
  }): Promise<void>;
}
/** Persisted public gates support reconnecting without continuing agent polling. */
export class DemoDelivery {
  constructor(
    readonly round: DemoRound,
    readonly adapter: DemoDeliveryAdapter,
  ) {}
  /** Reject invalid decomposition or premature sequential dispatch and retain the observed boundary. */
  async gate(stage: 'worker1' | 'worker2' | 'closure') {
    const facts = await this.adapter.inspect();
    const pass =
      facts.children.length === 2 &&
      facts.nativeDependency &&
      (stage === 'worker1' || facts.firstReleased) &&
      (stage !== 'closure' || (facts.secondBaseline && facts.accepted));
    appendFileSync(
      join(this.round.root, 'delivery-boundaries.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), stage, pass, facts }) + '\n',
    );
    if (!pass)
      throw new Error('Native structure or complete sequential delivery prerequisite failed');
    return facts;
  }
  /** Present the actual version before accepting a human decision. */
  async request() {
    const facts = await this.gate('closure');
    writeFileSync(
      join(this.round.root, 'closure-request.json'),
      JSON.stringify({ deliveryVersion: facts.version }),
    );
    return facts;
  }
  /** Only explicitly invoked human control creates consent, bound to the displayed version. */
  async confirm(version: string, confirmed: boolean) {
    const facts = await this.gate('closure');
    const request = JSON.parse(readFileSync(join(this.round.root, 'closure-request.json'), 'utf8'));
    if (!confirmed || request.deliveryVersion !== version || facts.version !== version)
      throw new Error('Expected explicit human confirmation of current requested delivery version');
    const consent = {
      deliveryVersion: version,
      source: 'human' as const,
      evidence: `Operator pc demo confirm for round ${this.round.id} at ${new Date().toISOString()}`,
    };
    writeFileSync(join(this.round.root, 'human-closure.json'), JSON.stringify(consent));
    return consent;
  }
  /** Orchestrator invokes actual close after rechecking current consent; adapter verifies the existing closure gate. */
  async close() {
    const facts = await this.gate('closure');
    const consent = JSON.parse(readFileSync(join(this.round.root, 'human-closure.json'), 'utf8'));
    if (consent.source !== 'human' || consent.deliveryVersion !== facts.version)
      throw new Error('Stale or missing human closure consent');
    await this.adapter.close(consent);
  }
}
/** Historical checks use durable observed boundary snapshots, never eventual output alone. */
export async function demoChronology(round: DemoRound) {
  const path = join(round.root, 'delivery-boundaries.jsonl');
  const events: { at: string; stage: string; pass: boolean; facts: DemoDeliverySnapshot }[] =
    existsSync(path)
      ? readFileSync(path, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((x) => JSON.parse(x))
      : [];
  const registry = inspectRuns(loadFleetConfig(join(round.checkout, '.epic-config.json')));
  const worker2 = (registry.dispatches ?? []).filter(
    (d) => d.role === 'worker' && events.some((e) => d.subject.endsWith('#' + e.facts.children[1])),
  );
  const witnessed =
    worker2.length > 0 &&
    worker2.every((d) =>
      d.attempts.every((a) =>
        events.some(
          (e) => e.stage === 'worker2' && e.pass && Date.parse(e.at) <= Date.parse(a.created),
        ),
      ),
    );
  return [
    {
      stage: 'ordering',
      expected: 'Witnessed complete handover before Worker 2 dispatch',
      observed: JSON.stringify(events),
      verdict: events.some((e) => !e.pass)
        ? ('finding' as const)
        : witnessed
          ? ('pass' as const)
          : ('missing' as const),
      reference: path,
    },
  ];
}
