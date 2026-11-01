import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  startOrchestrator,
  inspectOrchestrator,
  type RunnerAdapter,
} from '../../packages/core/src/workflow/runtime/runtime.js';

test('startup requires runner evidence and isolates fleets, retaining a failed brief', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-runtime-')));
  const config = (name: string) => {
    const project = join(root, name);
    mkdirSync(project);
    return {
      file: join(project, '.epic-config.json'),
      project,
      root,
      slots: [],
      worktrees: false,
      base: 'main',
    };
  };
  const a = config('a');
  const b = config('b');
  const runner: RunnerAdapter = {
    interactive: true,
    name: 'controlled',
    async preflight() {},
    async start(attempt) {
      return { conversation: attempt.id, address: 'tmux:test', evidence: 'runner received brief' };
    },
  };
  try {
    const first = await startOrchestrator(a, runner, 'read AGENTS.md', 'run-a');
    expect(first.status).toBe('running');
    expect(first.role).toBe('orchestrator');
    expect(inspectOrchestrator(a, 'run-a')?.conversation).toBe(first.id);
    await expect(startOrchestrator(a, runner, 'duplicate', 'run-a')).rejects.toThrow(/occupied/);
    const failed = await startOrchestrator(
      b,
      {
        ...runner,
        async start() {
          throw new Error('no runner acknowledgement');
        },
      },
      'keep this brief',
      'run-b',
    );
    expect(failed.status).toBe('unknown');
    expect(inspectOrchestrator(b, 'run-b')).toMatchObject({
      brief: 'keep this brief',
      error: 'no runner acknowledgement',
    });
    expect(failed.fleet).not.toBe(first.fleet);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

test('missing capabilities refuse launch; an empty receipt cannot report successful startup', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-capability-')));
  const config = {
    file: join(root, '.epic-config.json'),
    project: root,
    root,
    slots: [],
    worktrees: false,
    base: 'main',
  };
  const runner: RunnerAdapter = {
    interactive: true,
    name: 'controlled',
    async preflight() {
      throw new Error('missing input capability');
    },
    async start() {
      throw new Error('must not launch');
    },
  };
  try {
    // @ts-expect-error Exercise the JavaScript boundary without a Run id.
    await expect(startOrchestrator(config, runner, 'brief')).rejects.toThrow('Run id');
    await expect(startOrchestrator(config, runner, 'brief', 'run-a')).rejects.toThrow(
      'missing input capability',
    );
    expect(inspectOrchestrator(config, 'run-a')).toBeUndefined();
    const result = await startOrchestrator(
      config,
      {
        ...runner,
        async preflight() {},
        async start() {
          return { conversation: '', address: 'tmux:only', evidence: '' };
        },
      },
      'retained',
      'run-a',
    );
    expect(result).toMatchObject({ status: 'unknown', brief: 'retained' });
    expect(result.error).toContain('startup evidence');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

test('core waits and cancellation preserve occupied identity until verified termination', async () => {
  const { waitAttempt, cancelAttempt, inspectAttemptControl, reconcileAttempt } =
    await import('../../packages/core/src/workflow/runtime/runtime.js');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-core-control-')));
  try {
    const attempt = {
      id: 'attempt',
      fleet: 'fleet',
      role: 'worker' as const,
      runner: 'controlled',
      brief: 'work',
      status: 'running' as const,
      created: 'now',
      directory: root,
      checkout: root,
    };
    let finish!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      finish = resolve;
    });
    expect(await waitAttempt(attempt, { collect: () => pending }, 1)).toEqual({ timedOut: true });
    expect(attempt.status).toBe('running');
    expect((await cancelAttempt(attempt, {})).cancellation?.outcome).toBe('unsupported');
    expect(
      (
        await cancelAttempt(attempt, {
          cancellation: true,
          async cancel() {
            throw new Error('refused');
          },
        })
      ).cancellation?.outcome,
    ).toBe('failed');
    expect((await reconcileAttempt(attempt, {})).execution?.status).toBe('unknown');
    finish('late result');
    expect(await waitAttempt(attempt, { collect: () => pending }, 100)).toEqual({
      timedOut: false,
      result: 'late result',
    });
    expect(
      (
        await cancelAttempt(attempt, {
          cancellation: true,
          async cancel() {
            return { evidence: 'verified process exit' };
          },
        })
      ).execution?.status,
    ).toBe('terminated');
    expect(inspectAttemptControl(attempt).cancellation?.evidence).toBe('verified process exit');
    expect(attempt.status).toBe('running'); // checkout and role ownership unchanged
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
