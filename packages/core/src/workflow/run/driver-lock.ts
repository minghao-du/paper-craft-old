/** Process ownership for recoverable local workflow drivers; Runner ownership is separate. */
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
/** Claim only after a previous driver process is verifiably absent. Legacy locks stay unknown. */
export function claimDriver(path: string): void {
  try {
    mkdirSync(path);
  } catch (error) {
    let pid: number;
    try {
      pid = Number(readFileSync(join(path, 'pid'), 'utf8'));
    } catch {
      throw new Error('Unknown legacy driver occupancy; inspect original execution', {
        cause: error,
      });
    }
    if (!Number.isSafeInteger(pid) || pid < 1)
      throw new Error('Invalid driver owner; preserve occupancy', { cause: error });
    try {
      process.kill(pid, 0);
      throw new Error('Driver remains occupied', { cause: error });
    } catch (probe) {
      if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe;
    }
    const guard = path + '.recovering';
    mkdirSync(guard);
    try {
      if (Number(readFileSync(join(path, 'pid'), 'utf8')) !== pid)
        throw new Error('Driver ownership changed', { cause: error });
      rmSync(path, { recursive: true });
      mkdirSync(path);
      writeFileSync(join(path, 'pid'), String(process.pid), { flag: 'wx' });
      return;
    } finally {
      rmSync(guard, { recursive: true });
    }
  }
  writeFileSync(join(path, 'pid'), String(process.pid), { flag: 'wx' });
}
