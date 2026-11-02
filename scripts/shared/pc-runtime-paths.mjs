/** Reject redirected runtime state before any read or mutation. */
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
export function runtimeRoot(rootText) {
  const runtime = join(realpathSync(rootText), '.runtime');
  function check(path, worktrees = false) {
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Runtime path must not be a symlink: ${path}`);
    if (stat.isDirectory() && !worktrees)
      for (const entry of readdirSync(path)) check(join(path, entry), path.endsWith('/worktrees'));
  }
  check(runtime);
  return runtime;
}
