import { realpathSync, mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { Subagents, type ShortRunner } from '../../packages/core/src/workflow/runtime/subagents.js';

test('all core parents delegate owned read/write tasks with durable results, queue limits and Worker handoff', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-short-')));
  mkdirSync(join(root, 'pool'));
  const config = {
    file: join(root, '.epic-config.json'),
    project: root,
    root: join(root, 'pool'),
    slots: [],
    worktrees: false,
    base: 'main',
  };
  const manager = new Subagents(config, { fleet: 1, parent: 1 });
  let active = 0,
    peak = 0;
  const runner: ShortRunner = {
    interactive: true,
    name: 'controlled',
    async run(task) {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      if (task.parent.role === 'landing') {
        active--;
        return { status: 'failed', result: 'task rejected', evidence: 'verified exit 1' };
      }
      if (task.mode === 'write') writeFileSync(join(task.checkout, 'owned.txt'), 'changed');
      active--;
      return { status: 'succeeded', result: 'delivered', evidence: 'verified terminal receipt' };
    },
  };
  try {
    const tasks = ['orchestrator', 'epic', 'worker', 'landing'].map((role) =>
      manager.create({
        parent: { id: role, role: role as 'worker', task: 'issue-1' },
        checkout: root,
        mode: role === 'worker' ? 'write' : 'read',
        brief: 'inspect owned file',
        files: role === 'worker' ? ['owned.txt'] : [],
      }),
    );
    expect(manager.list().filter((t) => t.status === 'queued')).toHaveLength(4);
    await Promise.all([manager.dispatch(runner), manager.dispatch(runner)]);
    expect(peak).toBe(1);
    expect(readFileSync(join(root, 'owned.txt'), 'utf8')).toBe('changed');
    for (const t of tasks) {
      expect(manager.collect(t.id)).toMatchObject({
        result: t.parent.role === 'landing' ? 'task rejected' : 'delivered',
        parent: t.parent,
      });
      manager.cleanup(t.id);
      expect(manager.get(t.id).status).toBe(t.parent.role === 'landing' ? 'failed' : 'succeeded');
    }
    expect(manager.handoff(tasks[0].id, 17)).toMatchObject({ issue: 17, status: 'requested' });
    expect(() =>
      manager.create({
        parent: tasks[0].parent,
        checkout: tmpdir(),
        mode: 'write',
        brief: 'bad',
        files: ['x'],
      }),
    ).toThrow(/configured/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

test('unverified execution retains capacity and collected failures remain distinguishable', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-short-fail-')));
  const config = {
    file: join(root, 'config'),
    project: root,
    root,
    slots: [],
    worktrees: false,
    base: 'main',
  };
  try {
    const manager = new Subagents(config, { fleet: 1, parent: 1 });
    const input = {
      parent: { id: 'parent', role: 'worker' as const, task: 'task' },
      checkout: root,
      mode: 'read' as const,
      files: [],
      brief: 'inspect',
    };
    const first = manager.create(input),
      next = manager.create(input);
    await manager.dispatch({
      name: 'lost',
      async run() {
        throw new Error('lost receipt');
      },
    });
    expect(
      manager
        .list()
        .map((t) => t.status)
        .sort(),
    ).toEqual(['queued', 'unknown']);
    expect(() => manager.cleanup(first.id)).toThrow(/Collect/);
    expect(manager.get(next.id).parent.id).toBe('parent');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

test('wait timeout and failed cancellation retain execution and capacity until a terminal receipt', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-control-')));
  const config = {
    file: join(root, 'config'),
    project: root,
    root,
    slots: [],
    worktrees: false,
    base: 'main',
  };
  try {
    const manager = new Subagents(config, { fleet: 1, parent: 1 });
    const input = {
      parent: { id: 'worker', role: 'worker' as const, task: 'issue' },
      checkout: root,
      mode: 'read' as const,
      files: [],
      brief: 'inspect',
    };
    const first = manager.create(input);
    let finish!: (value: { status: 'succeeded'; result: string; evidence: string }) => void;
    const dispatch = manager.dispatch({
      interactive: true,
      name: 'controlled',
      run: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const second = manager.create(input);
    await manager.wait(first.id, 1);
    expect(manager.get(first.id)).toMatchObject({ status: 'running', wait: { timedOut: true } });
    await manager.cancel(first.id, {
      name: 'unsupported',
      cancellation: false,
      async run() {
        throw new Error('unused');
      },
    });
    expect(manager.get(first.id)).toMatchObject({
      status: 'running',
      cancellation: { outcome: 'unsupported' },
    });
    await manager.cancel(first.id, {
      name: 'failed',
      cancellation: true,
      async cancel() {
        throw new Error('refused');
      },
      async run() {
        throw new Error('unused');
      },
    });
    expect(manager.get(first.id)).toMatchObject({
      status: 'running',
      cancellation: { outcome: 'failed' },
    });
    expect(manager.get(second.id).status).toBe('queued');
    finish({ status: 'succeeded', result: 'late result', evidence: 'verified exit 0' });
    // Second execution is also controlled; keep this test focused on the first receipt.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(manager.collect(first.id).result).toBe('late result');
    finish({ status: 'succeeded', result: 'second', evidence: 'verified exit 0' });
    await dispatch;
    expect(manager.get(first.id).cancellation?.outcome).toBe('failed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

test('unknown execution reserves capacity and only verified cancellation permits another task', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-cancel-')));
  const config = {
    file: join(root, 'config'),
    project: root,
    root,
    slots: [],
    worktrees: false,
    base: 'main',
  };
  try {
    const manager = new Subagents(config, { fleet: 1, parent: 1 });
    const input = {
      parent: { id: 'parent', role: 'landing' as const, task: 'task' },
      checkout: root,
      mode: 'read' as const,
      files: [],
      brief: 'inspect',
    };
    const first = manager.create(input);
    await manager.dispatch({
      name: 'lost',
      async run() {
        throw new Error('connection lost');
      },
    });
    const second = manager.create(input);
    expect(
      (
        await manager.reconcile(first.id, {
          name: 'lost',
          async run() {
            throw new Error('unused');
          },
        })
      ).status,
    ).toBe('unknown');
    await manager.dispatch({
      name: 'blocked',
      async run() {
        throw new Error('must not dispatch');
      },
    });
    expect(manager.get(second.id).status).toBe('queued');
    await expect(Promise.resolve().then(() => manager.collect(first.id))).rejects.toThrow(
      /terminal/,
    );
    const cancelled = await manager.cancel(first.id, {
      name: 'verified',
      cancellation: true,
      async cancel() {
        return { evidence: 'adapter confirmed exit for this attempt' };
      },
      async run() {
        throw new Error('unused');
      },
    });
    expect(cancelled).toMatchObject({ status: 'failed', cancellation: { outcome: 'confirmed' } });
    await manager.dispatch({
      name: 'next',
      async run() {
        return { status: 'succeeded', result: 'next done', evidence: 'exit0' };
      },
    });
    expect(manager.collect(second.id).result).toBe('next done');
    expect(manager.get(first.id).parent.id).toBe('parent');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
