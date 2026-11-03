/** Local adapter for detached per-Run startup supervision. */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDirectory } from '../handoff.js';
import type { FleetConfig } from '../fleet/fleet-config.js';
import type { RunnerAdapter } from './runtime.js';
import type { RunRegistry } from '../run/run-driver.js';
import { startupPending } from '../run/startup.js';

/** Startup helper evidence is scoped to the immutable Run identity. */
export function startupDirectory(config: FleetConfig, runId: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error('Expected a valid Run id');
  return stateDirectory(
    config,
    '.runtime',
    createHash('sha256').update(config.file).digest('hex'),
    'runs',
    runId,
  );
}

/** Report helper ownership independently of Run/Attempt activation. */
export function startupRecoveryStatus(config: FleetConfig, runId: string, registry?: RunRegistry) {
  let active = false;
  let pending: boolean | undefined;
  let evidenceDirectory: string | undefined;
  let error: string | undefined;
  try {
    pending = startupPending(config, runId, registry);
    evidenceDirectory = startupDirectory(config, runId);
    try {
      const pid = Number(readFileSync(join(evidenceDirectory, 'startup.lock', 'pid'), 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0) {
        process.kill(pid, 0);
        active = true;
      }
    } catch {
      /* Missing or stopped helper; repeated start repairs it. */
    }
  } catch (cause) {
    error = String(cause);
  }
  return { active, pending, evidenceDirectory, error };
}

/** Launch only the provider adapter's opt-in helper; test/custom adapters stay in-process. */
export function ensureStartupRecovery(
  config: FleetConfig,
  runner: RunnerAdapter,
  runId: string,
): void {
  if (
    !runner.automaticStartup ||
    !startupPending(config, runId) ||
    startupRecoveryStatus(config, runId).active
  )
    return;
  const directory = startupDirectory(config, runId);
  mkdirSync(directory, { recursive: true });
  const log = openSync(join(directory, 'startup.log'), 'a', 0o600);
  try {
    const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
    const entry = fileURLToPath(new URL('../runtime/startup-watch' + extension, import.meta.url));
    const loaderArgs: string[] = [];
    for (let i = 0; i < process.execArgv.length; i++) {
      const arg = process.execArgv[i];
      if (/^--(import|require|loader|conditions)(=|$)/.test(arg)) {
        loaderArgs.push(arg);
        if (!arg.includes('=')) loaderArgs.push(process.execArgv[++i]);
      }
    }
    const child = spawn(process.execPath, [...loaderArgs, entry, config.file, runId], {
      cwd: config.project,
      detached: true,
      stdio: ['ignore', log, log],
    });
    child.on('error', (error) => console.error('Startup helper failed:', error.message));
    child.unref();
  } finally {
    closeSync(log);
  }
}

/** Stop the detached per-Run startup helper and verify its termination. */
export async function stopStartupRecovery(
  config: FleetConfig,
  runId: string,
  timeoutMs = 5000,
): Promise<boolean> {
  let evidenceDirectory: string;
  try {
    evidenceDirectory = startupDirectory(config, runId);
  } catch {
    return true;
  }
  const pidFile = join(evidenceDirectory, 'startup.lock', 'pid');
  if (!existsSync(pidFile)) return true;
  let pid: number;
  try {
    pid = Number(readFileSync(pidFile, 'utf8'));
  } catch {
    return true;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
  } catch {
    rmSync(join(evidenceDirectory, 'startup.lock'), { recursive: true, force: true });
    return true;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return true;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      return true;
    }
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

