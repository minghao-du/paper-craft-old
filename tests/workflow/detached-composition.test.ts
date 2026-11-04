import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { FleetConfig } from '../../packages/core/src/workflow/fleet/fleet-config.js';
import type { ManagedAttempt, RunnerAdapter } from '../../packages/core/src/workflow/runtime/runtime.js';
import {
  startRun,
  stopRun,
  releaseRun,
  inspectRuns,
  updateRunRegistry,
} from '../../packages/core/src/workflow/run/run-driver.js';
import {
  ensureStartupRecovery,
  startupRecoveryStatus,
  superviseStartup,
  setStartupSupervisorLauncher,
  getStartupSupervisorLauncher,
} from '../../packages/core/src/workflow/runtime/startup-supervisor.js';
import { createRunner } from '../../packages/cli/src/workflow/composition.js';
import { initializeRole } from './initialize-role.js';

describe('Compose Agy execution explicitly in foreground and background hosts (#145)', () => {
  test('Core does not import or instantiate concrete providers in coordination or supervision', () => {
    const runtimeSource = readFileSync(
      join(process.cwd(), 'packages/core/src/workflow/runtime/runtime.ts'),
      'utf8',
    );
    const supervisorSource = readFileSync(
      join(process.cwd(), 'packages/core/src/workflow/runtime/startup-supervisor.ts'),
      'utf8',
    );
    const runDriverSource = readFileSync(
      join(process.cwd(), 'packages/core/src/workflow/run/run-driver.ts'),
      'utf8',
    );

    // Core coordination must not import concrete providers
    expect(runtimeSource).not.toMatch(/import.*AgyRunner/);
    expect(runtimeSource).not.toMatch(/import.*ClaudeRunner/);
    expect(runtimeSource).not.toMatch(/import.*CodexRunner/);
    expect(runtimeSource).not.toMatch(/new\s+AgyRunner/);
    expect(runtimeSource).not.toMatch(/new\s+ClaudeRunner/);
    expect(runtimeSource).not.toMatch(/new\s+InteractiveCodexRunner/);

    // Supervision must not contain script paths or concrete providers
    expect(supervisorSource).not.toMatch(/new\s+AgyRunner/);
    expect(supervisorSource).not.toMatch(/(managedRunner|createRunner)/);
    expect(supervisorSource).not.toMatch(/startup-watch/);
    expect(supervisorSource).not.toMatch(/child_process/);

    // Run driver must not import managedRunner or createRunner
    expect(runDriverSource).not.toMatch(/import.*(managedRunner|createRunner)/);

    // Core background startup-watch script must be removed from Core
    expect(
      existsSync(join(process.cwd(), 'packages/core/src/workflow/runtime/startup-watch.ts')),
    ).toBe(false);
  });

  test('Host composition creates concrete Agy runner and rejects unsupported providers', () => {
    const agy = createRunner('agy');
    expect(agy.name).toBe('agy');
    expect(agy.interactive).toBe(true);
    expect(agy.automaticStartup).toBe(true);
    expect(agy.constructor.name).toBe('AgyRunner');

    expect(() => createRunner('unknown-provider')).toThrow(/Unsupported managed provider/);
  });

  test('Supervision launcher seam is invoked by ensureStartupRecovery', () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-comp-test-')));
    mkdirSync(join(project, 'pool'));
    const config: FleetConfig = {
      file: join(project, '.epic-config.json'),
      project,
      root: join(project, 'pool'),
      slots: [],
      worktrees: true,
      base: 'main',
    };
    writeFileSync(config.file, JSON.stringify({ clone_root: 'pool' }));

    const launchedRuns: string[] = [];
    const fakeLauncher = (_conf: FleetConfig, runId: string) => {
      launchedRuns.push(runId);
    };

    const previousLauncher = getStartupSupervisorLauncher();
    try {
      setStartupSupervisorLauncher(fakeLauncher);

      const fakeRunner: RunnerAdapter = {
        name: 'agy',
        interactive: true,
        automaticStartup: true,
        async preflight() {},
        async start() {
          return { conversation: 'c1', address: 'tmux:t1', evidence: 'started' };
        },
      };

      // Create a pending run in the registry
      updateRunRegistry(config, (reg) => {
        reg.runs.push({
          id: 'test-run-1',
          provider: 'agy',
          subject: { repository: 'o/r', number: 1, kind: 'issue', title: 't', body: 'b' },
          lifecycle: 'running',
          orchestratorId: 'att-1',
          orchestrator: {
            id: 'att-1',
            fleet: 'f',
            role: 'orchestrator',
            runner: 'agy',
            brief: 'b',
            status: 'running',
            startupGate: true,
            created: new Date().toISOString(),
            directory: project,
            checkout: project,
          },
        });
      });

      ensureStartupRecovery(config, fakeRunner, 'test-run-1');
      expect(launchedRuns).toEqual(['test-run-1']);
    } finally {
      setStartupSupervisorLauncher(previousLauncher);
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('Demonstrate Agy startup, detached continuation and verified stop through composed path', async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-comp-e2e-')));
    mkdirSync(join(project, 'pool'));
    const config: FleetConfig = {
      file: join(project, '.epic-config.json'),
      project,
      root: join(project, 'pool'),
      slots: [],
      worktrees: true,
      base: 'main',
    };
    writeFileSync(config.file, JSON.stringify({ clone_root: 'pool', local_worktrees: true }));

    const runner = createRunner('agy');
    let continuationDelivered = false;

    // Use test-controlled execution overrides on the composed runner
    runner.preflight = async () => {};
    runner.start = async (attempt: ManagedAttempt) => {
      attempt.startupGate = true;
      attempt.address = 'tmux:composed-test';
      attempt.conversation = 'conv-1';
      initializeRole(attempt);
      return { conversation: 'conv-1', address: 'tmux:composed-test', evidence: 'start-evidence' };
    };
    runner.recoverReceipt = async () => ({
      conversation: 'conv-1',
      address: 'tmux:composed-test',
      evidence: 'recovered-receipt',
    });
    runner.send = async (_attempt, message) => {
      continuationDelivered = true;
      return { status: 'delivered', evidence: `delivered ${message.id}` };
    };

    let stoppedConfirmed = false;
    runner.cancel = async () => {
      stoppedConfirmed = true;
      return { evidence: 'termination-verified' };
    };
    runner.stopped = async () => stoppedConfirmed;
    runner.terminate = async () => {
      stoppedConfirmed = true;
      return { status: 'terminated', evidence: 'termination-verified' };
    };

    const previousLauncher = getStartupSupervisorLauncher();
    try {
      // Launcher seam registers interest without child process in unit test
      let launcherCalled = false;
      setStartupSupervisorLauncher((_c, _runId) => {
        launcherCalled = true;
      });

      // 1. Foreground start through composed runner
      const run = await startRun(
        config,
        runner,
        { repository: 'owner/repo', number: 42, kind: 'issue', title: 'Composed flow', body: 'body' },
        'agy',
      );
      expect(run.id).toBeDefined();
      expect(launcherCalled).toBe(true);

      // 2. Detached supervision step through Core superviseStartup algorithm
      const abortController = new AbortController();
      let reconciled = false;
      const supervisorPromise = superviseStartup(config, runner, run.id, {
        signal: abortController.signal,
        intervalMs: 50,
        onReconciled: () => {
          reconciled = true;
        },
      });

      await supervisorPromise;
      expect(reconciled).toBe(true);
      expect(continuationDelivered).toBe(true);

      // 3. Verified stop with explicit runner injection
      const stopResult = await stopRun(config, runner, run.id);
      expect(stopResult.terminated).toBe(true);
      expect(inspectRuns(config).runs[0].lifecycle).toBe('blocked');
    } finally {
      setStartupSupervisorLauncher(previousLauncher);
      rmSync(project, { recursive: true, force: true });
    }
  });
});
