import { openSync, closeSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FleetConfig } from '@paper-craft/core/workflow/fleet-config';
import type { RunnerAdapter, ManagedAttempt } from '@paper-craft/core/workflow/runtime';
import {
  startupDirectory,
  setStartupSupervisorLauncher,
} from '@paper-craft/core/workflow/startup';
import { setDemoRunnerResolver } from '@paper-craft/core/workflow/demo-execution';
import { AgyRunner } from '@paper-craft/core/workflow/runtime/agy';

/**
 * Runner composition interface combining standard RunnerAdapter with stopped verification.
 */
export type ComposedRunner = RunnerAdapter & {
  stopped(attempt: ManagedAttempt): Promise<boolean>;
};

/**
 * Shared host runner composition.
 * Resolves concrete RunnerAdapter for foreground and background hosts.
 */
export function createRunner(provider: string): ComposedRunner {
  switch (provider) {
    case 'agy':
      return new AgyRunner();
    default:
      throw new Error(`Unsupported managed provider '${provider}'. Only 'agy' is supported.`);
  }
}

/**
 * Host launcher for detached startup supervision.
 * Belongs to the host: manages script location and background process launch.
 */
export function launchStartupSupervisor(config: FleetConfig, runId: string): void {
  const directory = startupDirectory(config, runId);
  mkdirSync(directory, { recursive: true });
  const log = openSync(join(directory, 'startup.log'), 'a', 0o600);
  try {
    const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
    const entry = fileURLToPath(new URL('./startup-watch' + extension, import.meta.url));
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

// Automatically configure Core with this host's supervisor launcher and demo runner resolver
setStartupSupervisorLauncher(launchStartupSupervisor);
setDemoRunnerResolver(createRunner);
