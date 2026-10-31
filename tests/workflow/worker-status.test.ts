import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

// CLI contract: interrupted sessions must discover receipts without losing them on inspection.
it('reports active attempts and retains unhandled receipts until explicitly acknowledged', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-status-'));
  const invoke = (...args: string[]) =>
    JSON.parse(execFileSync(resolve('pc'), [...args, '--root', root], { encoding: 'utf8' }));
  try {
    const run = invoke('run', 'create', '--issue', '79', '--runner', 'fake');
    for (const id of ['active', 'done']) {
      const dir = join(root, '.runtime/default/runs', run.run_id, 'dispatches', id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'dispatch.json'),
        JSON.stringify({ dispatch_id: id, run_id: run.run_id, issue_id: 80, role: 'worker' }),
      );
      if (id === 'done')
        writeFileSync(join(dir, 'RECEIPT.md'), 'outcome: succeeded\nsummary: implemented\n');
    }
    const status = invoke('worker', 'status', run.run_id);
    expect(status.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dispatch_id: 'active', state: 'in-flight' }),
        expect.objectContaining({
          dispatch_id: 'done',
          state: 'completed',
          handled: false,
          receipt: 'outcome: succeeded\nsummary: implemented\n',
        }),
      ]),
    );
    expect(invoke('status', run.run_id)).toEqual(status);
    const acknowledged = invoke('worker', 'status', run.run_id, '--ack', 'done');
    expect(
      acknowledged.attempts.find((x: { dispatch_id: string }) => x.dispatch_id === 'done').handled,
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
