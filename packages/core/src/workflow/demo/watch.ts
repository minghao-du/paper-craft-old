/** Detached budget enforcement only; this helper never dispatches business work. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DemoControl } from './control.js';
import { nativeDemoExecution } from './execution.js';
import type { DemoRound } from './round.js';
const root = process.argv[2];
const round: DemoRound = JSON.parse(readFileSync(join(root, 'round.json'), 'utf8'));
if (round.root !== root) throw new Error('Watch round ownership mismatch');
const control = new DemoControl(round, nativeDemoExecution());
try {
  while (!control.status().stopped && !control.status().releasing) {
    await control.checkpoint(control.status().wait);
    await new Promise((r) => setTimeout(r, 1000));
  }
} catch (e) {
  writeFileSync(join(root, 'watch-error.txt'), String(e));
  await control.stop();
} finally {
  writeFileSync(
    join(root, 'watch-exit.json'),
    JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
  );
}
