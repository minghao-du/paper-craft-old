/** Controlled adapter fixture: writes actual existing role startup state before acknowledgement. */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ManagedAttempt } from '../../packages/core/src/workflow/runtime.js';
/**
 * Emulates role-specific startup evidence by writing the expected initialization
 * files (initialization.json, plus .epic-status.json and .epic-worklog.md for worker)
 * before acknowledgement is asserted.
 */
export function initializeRole(attempt: ManagedAttempt): void {
  const expected = attempt.initialization;
  if (!expected) return;
  readFileSync(expected.context.path, 'utf8');
  if (attempt.role === 'worker') {
    writeFileSync(
      join(attempt.checkout, '.epic-status.json'),
      JSON.stringify({
        issue: Number(expected.subject.split('#').at(-1)),
        phase: 'exploring',
        summary: 'Read assigned scope; verifying delivery',
        updated_at: new Date().toISOString(),
      }),
    );
    appendFileSync(
      join(attempt.checkout, '.epic-worklog.md'),
      `\n${new Date().toISOString()} Startup ${attempt.id}\n`,
    );
  }
  writeFileSync(join(attempt.directory, 'initialization.json'), JSON.stringify(expected));
}
