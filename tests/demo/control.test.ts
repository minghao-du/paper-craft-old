import { test, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoControl } from '../../packages/core/src/workflow/demo/control.js';
test('reconnected control retains observations and unknown stop occupancy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'demo-control-'));
  const round = {
    root,
    id: 'test',
    config: { root },
  } as unknown as import('../../packages/core/src/workflow/demo/round.js').DemoRound;
  const adapter = { start: async () => 'run', stop: async () => false };
  try {
    const c = new DemoControl(round, adapter);
    await c.start(true);
    c.report('Unexpected output', 'log');
    const reconnect = new DemoControl(round, adapter);
    expect(reconnect.status().observations[0].text).toBe('Unexpected output');
    expect((await reconnect.stop()).execution).toBe('unknown');
    expect(reconnect.status().stopped).toBe(true);
    await expect(reconnect.start(true)).rejects.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('active budget excludes human waiting and expires through stop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'demo-budget-'));
  const round = {
    root,
    id: 'test',
    config: { root },
  } as unknown as import('../../packages/core/src/workflow/demo/round.js').DemoRound;
  const c = new DemoControl(round, { start: async () => 'run', stop: async () => true });
  try {
    const s = await c.start(true, 1000);
    await c.checkpoint('human', s.tick + 500);
    await c.checkpoint(undefined, s.tick + 100000);
    expect(c.status().activeMs).toBe(500);
    await c.checkpoint(undefined, s.tick + 100501);
    expect(c.status().stopped).toBe(true);
    expect(c.status().execution).toBe('released');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
