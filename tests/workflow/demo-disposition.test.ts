import { test, expect } from 'vitest';
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DemoDisposition } from '../../packages/core/src/workflow/demo/disposition.js';
import type { DemoRound } from '../../packages/core/src/workflow/demo/round.js';

test('disposition retains uncertainty and late observations, deletes only verified owned clean rounds', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-dispose-')));
  const id = randomUUID();
  const dir = join(root, id);
  mkdirSync(dir);
  const round = {
    id,
    root: dir,
    config: { root, owner: 'toy', prefix: 'demo-' },
    repository: { id: 17, owner: 'toy', name: 'demo-' + id },
  } as DemoRound;
  writeFileSync(join(dir, 'round.json'), JSON.stringify(round));
  let clear = false;
  let deleted = false;
  let late = false;
  const result = {
    business: 'completed',
    defects: 'clear',
    execution: 'released',
    cleanup: 'pending',
    source: 'controlled',
  };
  const adapter = {
    verify: async () => ({ ...result, defects: clear ? 'clear' : 'inconclusive' }),
    released: async () => true,
    repository: async () => (deleted ? null : round.repository!),
    removeRepository: async () => {
      deleted = true;
    },
    removeLocal: async () => rmSync(dir, { recursive: true }),
    display: () => {
      if (late)
        writeFileSync(
          join(dir, 'control.json'),
          JSON.stringify({ observations: [{ text: 'late' }] }),
        );
    },
  };
  try {
    const d = new DemoDisposition(adapter as never);
    expect((await d.finish(round)).cleanup).toBe('retained');
    expect(deleted).toBe(false);
    rmSync(join(dir, 'disposition.json'));
    clear = true;
    late = true;
    expect((await d.finish(round)).cleanup).toBe('retained');
    expect(deleted).toBe(false);
    rmSync(join(dir, 'control.json'));
    late = false;
    // A retained scene requires explicit fresh-validation authorization even when checks later clear.
    expect((await d.finish(round)).cleanup).toBe('retained');
    const fresh = {
      ...round,
      id: randomUUID(),
      root: join(root, randomUUID()),
      repository: { ...round.repository!, id: 18, name: 'demo-fresh' },
    };
    const authorization = { fresh, confirmed: true };
    const originalRelease = adapter.released;
    adapter.released = async () => false;
    expect((await d.finish(round, authorization)).cleanup).toBe('retained');
    adapter.released = originalRelease;
    const repository = adapter.repository;
    adapter.repository = async () => ({ ...round.repository!, id: 999 });
    expect((await d.finish(round, authorization)).cleanup).toBe('failed');
    expect(deleted).toBe(false);
    adapter.repository = repository;
    const remove = adapter.removeRepository;
    adapter.removeRepository = async () => {
      throw new Error('HTTP 429 rate limited');
    };
    expect((await d.finish(round, authorization)).cleanup).toBe('failed');
    expect(existsSync(dir)).toBe(true);
    adapter.removeRepository = remove;
    expect((await d.finish(round, authorization)).cleanup).toBe('completed');
    expect(existsSync(dir)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clean release preserves business semantics and refuses another round lock', async () => {
  const { DemoControl } = await import('../../packages/core/src/workflow/demo/control.js');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-release-')));
  const id = randomUUID();
  const dir = join(root, id);
  mkdirSync(dir);
  const round = { id, root: dir, config: { root } } as DemoRound;
  mkdirSync(join(root, 'execution.lock'));
  writeFileSync(join(root, 'execution.lock', 'owner'), 'another-round');
  writeFileSync(
    join(dir, 'control.json'),
    JSON.stringify({
      runId: 'run',
      started: 1,
      stopped: false,
      execution: 'running',
      observations: [],
    }),
  );
  let completedMode = false;
  try {
    const control = new DemoControl(round, {
      start: async () => '',
      stop: async (_r, _id, completed) => {
        completedMode = completed === true;
        return true;
      },
    });
    const state = await control.release();
    expect(completedMode).toBe(true);
    expect(state.stopped).toBe(false);
    expect(state.execution).toBe('released');
    expect(existsSync(join(root, 'execution.lock'))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
