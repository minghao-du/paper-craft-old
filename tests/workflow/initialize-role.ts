/** Controlled adapter fixture: writes actual existing role startup state before acknowledgement. */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ManagedAttempt } from '../../packages/core/src/workflow/runtime/runtime.js';
/**
 * Emulates role-specific startup evidence by writing the expected initialization.json
 * in the attempt directory before acknowledgement is asserted.
 */
export function initializeRole(attempt: ManagedAttempt): void {
  const expected = attempt.initialization;
  if (!expected) return;
  readFileSync(expected.context.path, 'utf8');
  writeFileSync(join(attempt.directory, 'initialization.json'), JSON.stringify(expected));
}
