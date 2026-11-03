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

test('async start failure preserves observations submitted while startup waits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'demo-race-'));
  const round = {
    root,
    id: 'race',
    config: { root },
  } as unknown as import('../../packages/core/src/workflow/demo/round.js').DemoRound;
  let fail!: (e: Error) => void;
  const c = new DemoControl(round, {
    start: () =>
      new Promise<string>((_, reject) => {
        fail = reject;
      }),
    stop: async () => false,
  });
  try {
    const pending = c.start(true);
    c.report('observed during startup');
    fail(new Error('startup failed'));
    await expect(pending).rejects.toThrow('startup failed');
    expect(c.status().observations.map((o) => o.text)).toEqual(['observed during startup']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('permission wait pauses active budget and resumes with explicit evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'demo-permission-'));
  const round = {
    root,
    id: 'perm',
    config: { root },
  } as unknown as import('../../packages/core/src/workflow/demo/round.js').DemoRound;
  const c = new DemoControl(round, { start: async () => 'run', stop: async () => true });
  try {
    const s = await c.start(true, 5000);
    await expect(c.permissionWait('')).rejects.toThrow('Expected permission evidence');
    await expect(c.permissionResume()).rejects.toThrow('No permission wait to resume');

    await c.permissionWait('operator observed native permission prompt');
    expect(c.status().wait).toBe('permission');
    expect(c.status().permissionEvidence).toBe('operator observed native permission prompt');
    const activeAtPause = c.status().activeMs;

    // While waiting for permission, checkpoint with preserveWait does not consume active budget
    await c.checkpoint(undefined, s.tick + 100000, true);
    expect(c.status().activeMs).toBe(activeAtPause);

    // Cannot start permission wait during human wait
    await c.checkpoint('human');
    await expect(c.permissionWait('prompt')).rejects.toThrow('outside human closure wait');

    // Resume requires permission wait state
    await expect(c.permissionResume()).rejects.toThrow('No permission wait to resume');

    // Reset to permission wait
    await c.checkpoint('permission');
    await c.permissionResume();
    expect(c.status().wait).toBeUndefined();

    // After resuming, active time accumulates
    await c.checkpoint(undefined, s.tick + 100500);
    expect(c.status().activeMs).toBeGreaterThan(activeAtPause);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

