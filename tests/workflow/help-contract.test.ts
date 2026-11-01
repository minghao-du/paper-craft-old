/** Public workflow CLI help, including the full renamed command group. */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
for (const command of [
  '',
  'start',
  'status',
  'recover',
  'recover-all',
  'land',
  'finalize-epic',
  'close-epic',
]) {
  it(`publishes orchestrator ${command || 'group'} help`, () => {
    const args = ['workflow', 'orchestrator', ...(command ? [command] : []), '--help'];
    expect(
      execFileSync(resolve(root, 'pc'), args, { cwd: root, encoding: 'utf8', timeout: 20000 }),
    ).toMatchSnapshot();
  }, 25000);
}
