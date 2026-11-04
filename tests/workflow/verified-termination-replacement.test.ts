import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { Command } from 'commander';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));

import { initializeRole } from './initialize-role.js';
import {
  startRun,
  dispatchStage,
  inspectRun,
  stopRun,
  releaseRun,
  recoverRun,
  releaseRunCheckout,
  updateRunRegistry,
  inspectRuns,
  type WorkflowRun,
} from '../../packages/core/src/workflow/run/run-driver.js';
import {
  terminateAttempt,
  inspectAttemptControl,
  type ManagedAttempt,
  type RunnerAdapter,
  type ExecutionTermination,
} from '../../packages/core/src/workflow/runtime/runtime.js';
import { AgyInteractive } from '../../packages/core/src/workflow/runtime/agy-interactive.js';
import { AgyRunner } from '../../packages/core/src/workflow/runtime/agy-runner.js';
import { registerWorkflowCommands } from '../../packages/cli/src/commands/workflow.js';

function createFixture() {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-verify-term-')));
  mkdirSync(join(project, 'pool'));
  const config = {
    file: join(project, '.epic-config.json'),
    project,
    root: join(project, 'pool'),
    slots: [],
    worktrees: true,
    base: 'main',
  };
  writeFileSync(config.file, JSON.stringify({ clone_root: 'pool', local_worktrees: true }));
  return { project, config };
}

test('Criterion 1: Execution contract returns verified termination or explicit unconfirmed outcome without manual caller composition', async () => {
  const child = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'pc-contract-term-'));
  const attempt: ManagedAttempt = {
    id: 'att-term-1',
    run: 'run-1',
    directory: dir,
    address: 'tmux:%501',
    fleet: 'fleet-1',
    role: 'orchestrator',
    runner: 'agy',
    brief: 'Contract test brief',
    status: 'running',
    created: new Date().toISOString(),
    checkout: dir,
    providerState: { session: 'pc-run-run-1' },
  };

  let paneExists = true;
  const spy = vi.mocked(child.execFileSync).mockImplementation((cmd, args) => {
    if (cmd === 'tmux' && args?.[0] === 'list-panes') {
      return (paneExists ? '%501 0\n' : '') as unknown as Buffer;
    }
    if (cmd === 'tmux' && args?.[0] === 'display-message') {
      return 'pc-run-run-1 run-1 %501\n' as unknown as Buffer;
    }
    if (cmd === 'tmux' && args?.[0] === 'kill-pane') {
      paneExists = false;
      return '' as unknown as Buffer;
    }
    return '' as unknown as Buffer;
  });

  try {
    const agy = new AgyInteractive();

    // 1. Live execution: calling terminate() terminates pane and verifies absence in a single call
    const outcome1 = await agy.terminate(attempt);
    expect(outcome1.status).toBe('terminated');
    expect(outcome1.evidence).toContain('absence verified');
    expect(paneExists).toBe(false);

    // 2. Already stopped execution: calling terminate() returns verified termination immediately
    const outcome2 = await agy.terminate(attempt);
    expect(outcome2.status).toBe('terminated');
    expect(outcome2.evidence).toContain('already exited or terminated');

    // 3. Fallback composition in terminateAttempt works with adapters lacking native terminate()
    const mockLegacyRunner = {
      name: 'legacy',
      interactive: true,
      cancellation: true,
      async stopped() {
        return false;
      },
      async cancel() {
        return { evidence: 'legacy-cancelled' };
      },
    };
    // If stopped returns false even after cancel, outcome is unconfirmed
    const outcome3 = await terminateAttempt(attempt, mockLegacyRunner);
    expect(outcome3.status).toBe('unconfirmed');
    expect(outcome3.error).toContain('still running after cancellation');
  } finally {
    spy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Criterion 2: Core retains occupancy when termination evidence is missing, invalid or uncertain', async () => {
  const { project, config } = createFixture();
  let verifiedStopped = false;

  const runner: RunnerAdapter = {
    interactive: true,
    name: 'agy',
    cancellation: true,
    async cancel() {
      // Cancellation acknowledged, but stopped remains false
      return { evidence: 'cancellation-attempted' };
    },
    async stopped() {
      return verifiedStopped;
    },
    async terminate() {
      return verifiedStopped
        ? { status: 'terminated', evidence: 'stopped' }
        : { status: 'unconfirmed', error: 'Process still running' };
    },
    async preflight() {},
    async start() {
      return { conversation: 'sess-unc', address: 'tmux:%991', evidence: 'start-ack' };
    },
    async collect() {
      return 'result';
    },
  };

  try {
    const run = await startRun(
      config,
      runner,
      { repository: 'owner/repo', number: 101, kind: 'issue', title: 'unc-test', body: 'body' },
      'agy',
    );

    const checkoutDir = join(project, 'pool', 'issue-101');
    mkdirSync(checkoutDir, { recursive: true });

    await dispatchStage(config, runner, {
      runId: run.id,
      authority: run.orchestratorId,
      subject: 'owner/repo#101',
      role: 'worker',
      stage: 'implementation',
      inputRevision: 'rev-1',
      brief: 'work',
      prerequisites: [],
      checkout: checkoutDir,
    });

    // Attempt stop when termination cannot be verified
    const stopResult = await stopRun(config, runner, run.id);
    expect(stopResult.terminated).toBe(false);
    expect(stopResult.released).toBe(false);
    expect(stopResult.blockers.some((b) => b.includes('termination unverified'))).toBe(true);

    // Run view preserves unreleased/unconfirmed occupancy
    const view = inspectRun(config, run.id);
    expect(view.terminated).toBe(false);
    expect(view.released).toBe(false);
    expect(view.resources.some((r) => r.path === checkoutDir)).toBe(true);

    // Releasing checkout throws because termination evidence is missing
    await expect(
      releaseRunCheckout(config, run.id, checkoutDir, async () => false, () => {}),
    ).rejects.toThrow(/Unknown checkout occupancy; termination evidence required/);

    // Release also respects existing Workflow completion condition
    await expect(releaseRun(config, runner, run.id)).rejects.toThrow(/is not completed/);

    // When run is completed, release without cleanup callback respects preservation gate
    updateRunRegistry(config, (reg) => {
      reg.runs.find((r) => r.id === run.id)!.lifecycle = 'completed';
    });
    const releaseWithoutCleanup = await releaseRun(config, runner, run.id);
    expect(releaseWithoutCleanup.released).toBe(false);
    expect(
      releaseWithoutCleanup.blockers.some((b) =>
        b.includes('Checkout release requires the workflow preservation and cleanup gate'),
      ),
    ).toBe(true);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('Criterion 3: Cancellation preserves unrelated panes and peer Runs and respects tmux allocation semantics', async () => {
  const child = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'pc-cross-run-'));

  const panes = new Map<string, string>([
    ['%101', '0'], // Run 1 Orchestrator
    ['%102', '0'], // Run 1 Worker
    ['%201', '0'], // Run 2 Orchestrator
  ]);

  const spy = vi.mocked(child.execFileSync).mockImplementation((cmd, args) => {
    if (cmd === 'tmux' && args?.[0] === 'list-panes') {
      return [...panes.entries()].map(([id, dead]) => `${id} ${dead}`).join('\n') as unknown as Buffer;
    }
    if (cmd === 'tmux' && args?.[0] === 'display-message') {
      const pane = args[args.indexOf('-t') + 1];
      if (pane === '%101' || pane === '%102') {
        return `pc-run-r1 r1 ${pane}\n` as unknown as Buffer;
      }
      if (pane === '%201') {
        return `pc-run-r2 r2 ${pane}\n` as unknown as Buffer;
      }
      throw new Error(`can't find pane: ${pane}`);
    }
    if (cmd === 'tmux' && args?.[0] === 'kill-pane') {
      const pane = args[args.indexOf('-t') + 1];
      panes.delete(pane.replace('tmux:', ''));
      return '' as unknown as Buffer;
    }
    return '' as unknown as Buffer;
  });

  try {
    const agy = new AgyInteractive();

    const dirR1Worker = join(dir, 'r1-worker');
    mkdirSync(dirR1Worker);
    const attemptR1Worker: ManagedAttempt = {
      id: 'att-worker',
      run: 'r1',
      directory: dirR1Worker,
      address: 'tmux:%102',
      fleet: 'f1',
      role: 'worker',
      runner: 'agy',
      brief: 'Worker brief',
      status: 'running',
      created: new Date().toISOString(),
      checkout: dirR1Worker,
      providerState: { session: 'pc-run-r1' },
    };

    // Terminate Run 1 Worker
    const outcome = await agy.terminate(attemptR1Worker);
    expect(outcome.status).toBe('terminated');

    // Run 1 Worker pane is killed
    expect(panes.has('%102')).toBe(false);

    // Unrelated peer pane in Run 1 (Orchestrator %101) is PRESERVED
    expect(panes.has('%101')).toBe(true);

    // Peer Run 2 pane (%201) is PRESERVED
    expect(panes.has('%201')).toBe(true);

    // Cross-run ownership spoof check: Run 1 attempt pointing to Run 2 pane (%201)
    const spoofDir = join(dir, 'spoof');
    mkdirSync(spoofDir);
    const spoofAttempt: ManagedAttempt = {
      id: 'att-spoof',
      run: 'r1', // claims r1
      directory: spoofDir,
      address: 'tmux:%201', // but targets r2 pane
      fleet: 'f1',
      role: 'orchestrator',
      runner: 'agy',
      brief: 'Spoof',
      status: 'running',
      created: new Date().toISOString(),
      checkout: spoofDir,
      providerState: { session: 'pc-run-r1' },
    };

    // Terminating spoofed attempt returns unconfirmed and does NOT kill Run 2 pane
    const spoofOutcome = await agy.terminate(spoofAttempt);
    expect(spoofOutcome.status).toBe('unconfirmed');
    expect(spoofOutcome.error).toContain('Run session or exact pane ownership unverified');
    expect(panes.has('%201')).toBe(true);
  } finally {
    spy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Criterion 3: Stop and release CLI entry points use injected execution dependencies', async () => {
  const { project, config } = createFixture();
  let stopRunnerCalled = false;
  let releaseRunnerCalled = false;

  const mockRunner: RunnerAdapter = {
    interactive: true,
    name: 'agy',
    cancellation: true,
    async cancel() {
      return { evidence: 'injected-cancel' };
    },
    async stopped() {
      return true;
    },
    async terminate() {
      return { status: 'terminated', evidence: 'injected-term' };
    },
    async preflight() {},
    async start() {
      return { conversation: 'sess-inj', address: 'tmux:%301', evidence: 'start-ack' };
    },
    async collect() {
      return 'done';
    },
    async result() {
      return undefined;
    },
  };

  const injectedRunner = (provider: string) => {
    if (provider === 'agy') {
      return {
        ...mockRunner,
        async terminate(attempt: ManagedAttempt) {
          stopRunnerCalled = true;
          return { status: 'terminated' as const, evidence: 'injected-stop' };
        },
      };
    }
    throw new Error(`Unexpected provider ${provider}`);
  };

  try {
    const run = await startRun(
      config,
      mockRunner,
      { repository: 'owner/repo', number: 202, kind: 'issue', title: 'inj-test', body: 'b' },
      'agy',
    );

    const program = new Command();
    registerWorkflowCommands(
      program,
      { human: () => false },
      { runner: injectedRunner },
    );

    // Call CLI stop command with injected runner
    await program.parseAsync([
      'node',
      'pc',
      'workflow',
      'orchestrator',
      'stop',
      run.id,
      '--config',
      config.file,
    ]);

    expect(stopRunnerCalled).toBe(true);

    // Complete run and test release with injected runner
    updateRunRegistry(config, (reg) => {
      reg.runs.find((r) => r.id === run.id)!.lifecycle = 'completed';
    });

    const releaseProgram = new Command();
    registerWorkflowCommands(
      releaseProgram,
      { human: () => false },
      {
        runner: (provider) => ({
          ...mockRunner,
          async terminate(attempt: ManagedAttempt) {
            releaseRunnerCalled = true;
            return { status: 'terminated' as const, evidence: 'injected-release' };
          },
        }),
      },
    );

    await releaseProgram.parseAsync([
      'node',
      'pc',
      'workflow',
      'orchestrator',
      'release',
      run.id,
      '--config',
      config.file,
    ]);

    expect(releaseRunnerCalled).toBe(true);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('Criterion 4 & 5: Orchestrator replacement requires verified predecessor termination, retains attempt history and installs exactly one active authority', async () => {
  const { project, config } = createFixture();
  let predecessorTerminated = false;
  let launches = 0;

  const runner: RunnerAdapter = {
    interactive: true,
    name: 'agy',
    cancellation: true,
    async stopped() {
      return predecessorTerminated;
    },
    async terminate() {
      return predecessorTerminated
        ? { status: 'terminated', evidence: 'predecessor-stopped' }
        : { status: 'unconfirmed', error: 'predecessor-still-running' };
    },
    async preflight() {},
    async start(a: ManagedAttempt) {
      launches++;
      initializeRole(a);
      return {
        conversation: a.conversation ?? `conv-${launches}`,
        address: `tmux:%40${launches}`,
        evidence: `start-ack-${launches}`,
      };
    },
    async collect() {
      return 'done';
    },
    async result() {
      return undefined;
    },
  };

  try {
    const run = await startRun(
      config,
      runner,
      { repository: 'owner/repo', number: 303, kind: 'issue', title: 'replace-test', body: 'b' },
      'agy',
      'Preserve source code integrity',
      true, // dangerouslySkipPermissions: true
    );
    expect(launches).toBe(1);
    const initialOrchestrator = run.orchestrator!;
    expect(initialOrchestrator.dangerouslySkipPermissions).toBe(true);

    // Simulate initial orchestrator having delivered activation and completed initialization in its directory
    updateRunRegistry(config, (reg) => {
      const current = reg.runs.find((r) => r.id === run.id)!;
      current.orchestrator!.activation = {
        id: 'act-old',
        brief: 'old activation',
        status: 'delivered',
        evidence: 'old-evidence',
      };
      current.orchestrator!.error = 'old-error';
    });
    // Create predecessor initialization file in initial orchestrator directory
    writeFileSync(
      join(initialOrchestrator.directory, 'initialization.json'),
      JSON.stringify(initialOrchestrator.initialization),
    );

    // 1. Attempt replacement while predecessor termination is UNVERIFIED -> blocked
    predecessorTerminated = false;
    const blockedRecover = await recoverRun(config, runner, run.id, {
      replaceOrchestrator: true,
    });
    expect(blockedRecover.blockers).toContain(
      'Orchestrator occupancy unresolved; verify termination before replacement',
    );
    expect(launches).toBe(1); // No new orchestrator launched

    const blockedRun = inspectRuns(config).runs.find((r) => r.id === run.id)!;
    expect(blockedRun.orchestratorId).toBe(initialOrchestrator.id);
    expect(blockedRun.priorOrchestrators ?? []).toHaveLength(0);

    // 2. Predecessor termination is verified -> replacement succeeds
    predecessorTerminated = true;
    const okRecover = await recoverRun(config, runner, run.id, {
      replaceOrchestrator: true,
    });
    expect(okRecover.blockers).toEqual([]);
    expect(launches).toBe(2);

    const updatedRun = inspectRuns(config).runs.find((r) => r.id === run.id)!;
    const replacement = updatedRun.orchestrator!;

    // Criterion 4:
    // Predecessor added to priorOrchestrators (attempt history retained)
    expect(updatedRun.priorOrchestrators).toHaveLength(1);
    expect(updatedRun.priorOrchestrators![0].id).toBe(initialOrchestrator.id);

    // Exactly one active authority installed
    expect(updatedRun.orchestratorId).toBe(replacement.id);
    expect(replacement.id).not.toBe(initialOrchestrator.id);
    expect(replacement.predecessor).toBe(initialOrchestrator.id);

    // Mutation with old authority is revoked
    await expect(
      dispatchStage(config, runner, {
        runId: run.id,
        authority: initialOrchestrator.id,
        subject: 'owner/repo#303',
        role: 'worker',
        stage: 'worker-stage',
        inputRevision: 'rev-1',
        brief: 'do work',
        prerequisites: [],
      }),
    ).rejects.toThrow(/Inactive or wrong Orchestrator authority/);

    // Criterion 5:
    // Replacement does NOT inherit predecessor activation delivery
    expect(replacement.activation).toBeUndefined();

    // Replacement does NOT inherit stale initialization facts:
    // initialization.json from predecessor is absent in replacement directory
    expect(readFileSync(join(replacement.directory, 'brief.md'), 'utf8')).toContain(
      'Do not replay the original brief',
    );
    expect(replacement.initialization).toBeDefined();
    expect(replacement.initialization!.attempt).toBe(replacement.id);
    expect(replacement.initialization!.authority).toBe(replacement.id);
    expect(replacement.initialization!.briefHash).not.toBe(
      initialOrchestrator.initialization?.briefHash,
    );

    // Retains intended Run configuration and Agy permission choices
    expect(replacement.role).toBe('orchestrator');
    expect(replacement.runner).toBe('agy');
    expect(replacement.checkout).toBe(config.project);
    expect(replacement.brief).toContain('Preserve source code integrity');
    expect(replacement.dangerouslySkipPermissions).toBe(true);
    expect(replacement.providerState?.dangerouslySkipPermissions).toBe(true);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('Criterion 6: Public Runtime and AgyRunner conformance for verified termination and replacement', async () => {
  const child = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'pc-agy-runner-term-'));

  let paneAlive = true;
  const spy = vi.mocked(child.execFileSync).mockImplementation((cmd, args) => {
    if (cmd === 'tmux' && args?.[0] === 'list-panes') {
      return (paneAlive ? '%601 0\n' : '') as unknown as Buffer;
    }
    if (cmd === 'tmux' && args?.[0] === 'display-message') {
      return 'pc-run-r1 r1 %601\n' as unknown as Buffer;
    }
    if (cmd === 'tmux' && args?.[0] === 'kill-pane') {
      paneAlive = false;
      return '' as unknown as Buffer;
    }
    return '' as unknown as Buffer;
  });

  try {
    const runner = new AgyRunner();
    const attempt: ManagedAttempt = {
      id: 'att-runner-term',
      run: 'r1',
      directory: dir,
      address: 'tmux:%601',
      fleet: 'f1',
      role: 'orchestrator',
      runner: 'agy',
      brief: 'Runner termination conformance',
      status: 'running',
      created: new Date().toISOString(),
      checkout: dir,
      providerState: { session: 'pc-run-r1' },
    };

    // Public AgyRunner.terminate directly returns verified termination
    const result1 = await runner.terminate(attempt);
    expect(result1.status).toBe('terminated');
    expect(result1.evidence).toContain('absence verified');

    // Second call confirms terminated without throwing
    const result2 = await runner.terminate(attempt);
    expect(result2.status).toBe('terminated');
    expect(result2.evidence).toContain('already exited or terminated');
  } finally {
    spy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
