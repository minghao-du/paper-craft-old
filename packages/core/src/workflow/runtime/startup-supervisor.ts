/** Local adapter for detached per-Run startup supervision. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { stateDirectory } from '../handoff.js';
import type { FleetConfig } from '../fleet/fleet-config.js';
import type { RunnerAdapter } from './runtime.js';
import type { RunRegistry } from '../run/run-driver.js';
import { claimDriver } from '../run/driver-lock.js';
import { reconcileStartup, startupPending } from '../run/startup.js';

/** Host launcher function injected by foreground/background hosts. */
export type StartupSupervisorLauncher = (config: FleetConfig, runId: string) => void;

let hostSupervisorLauncher: StartupSupervisorLauncher | undefined;

/** Set the host-provided supervisor process launcher. */
export function setStartupSupervisorLauncher(
  launcher: StartupSupervisorLauncher | undefined,
): void {
  hostSupervisorLauncher = launcher;
}

/** Get the currently configured host supervisor process launcher. */
export function getStartupSupervisorLauncher(): StartupSupervisorLauncher | undefined {
  return hostSupervisorLauncher;
}

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

/** Launch only the provider adapter's opt-in helper; host owns script location and process launch. */
export function ensureStartupRecovery(
  config: FleetConfig,
  runner: RunnerAdapter,
  runId: string,
  launcher?: StartupSupervisorLauncher,
): void {
  if (
    !startupPending(config, runId) ||
    startupRecoveryStatus(config, runId).active
  )
    return;

  const launch = launcher ?? hostSupervisorLauncher;
  if (launch) {
    launch(config, runId);
  }
}

export interface SuperviseStartupOptions {
  intervalMs?: number;
  signal?: AbortSignal;
  onReconciled?: () => void;
  launcher?: StartupSupervisorLauncher;
}

/**
 * Supervise startup for a Run: claims the startup lock and repeatedly reconciles startup
 * until the Run is no longer pending or the process is stopped.
 * Supervision algorithm remains in Core behind an explicit host dependency.
 */
export async function superviseStartup(
  config: FleetConfig,
  runner: RunnerAdapter,
  runId: string,
  options?: SuperviseStartupOptions,
): Promise<void> {
  const lock = join(startupDirectory(config, runId), 'startup.lock');
  let owned = false;
  let stopped = false;
  const onSignal = () => {
    stopped = true;
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  if (options?.signal) {
    if (options.signal.aborted) stopped = true;
    else options.signal.addEventListener('abort', onSignal, { once: true });
  }
  const interval = options?.intervalMs ?? 2000;
  try {
    claimDriver(lock);
    owned = true;
    while (!stopped) {
      try {
        const stillPending = await reconcileStartup(config, runner, runId);
        if (!stillPending) {
          options?.onReconciled?.();
          break;
        }
      } catch (error) {
        console.error(new Date().toISOString(), String(error));
      }
      if (stopped) break;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  } catch (error) {
    if (owned) throw error;
  } finally {
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
    if (options?.signal) {
      options.signal.removeEventListener('abort', onSignal);
    }
    if (owned) {
      rmSync(lock, { recursive: true, force: true });
      // Release ownership before checking again: a concurrent dispatch cannot lose its wake-up.
      if (!stopped) {
        ensureStartupRecovery(config, runner, runId, options?.launcher);
      }
    }
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
  } catch {
    /* process already exited */
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}
