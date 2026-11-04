import { test, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoControl } from '../../tools/demo/control.js';
test('reconnected control retains observations and unknown stop occupancy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'demo-control-'));
  const round = {
    root,
    id: 'test',
    phase: 'provisioned',
    config: { root },
  } as unknown as import('../../tools/demo/round.js').DemoRound;
  const adapter = { stop: async () => false };
  try {
    const c = new DemoControl(round, adapter);
    await c.arm();
    c.bindRun('run');
    c.report('Unexpected output', 'log');
    const reconnect = new DemoControl(round, adapter);
    expect(reconnect.status().observations[0].text).toBe('Unexpected output');
    expect((await reconnect.stop()).execution).toBe('unknown');
    expect(reconnect.status().stopped).toBe(true);
    await expect(reconnect.arm()).rejects.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('active budget excludes human waiting and expires through stop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'demo-budget-'));
  const round = {
    root,
    id: 'test',
    phase: 'provisioned',
    config: { root },
  } as unknown as import('../../tools/demo/round.js').DemoRound;
  const c = new DemoControl(round, { stop: async () => true });
  try {
    const s = await c.arm(1000);
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

test('bind failure preserves observations submitted while round is active', async () => {
  const root = mkdtempSync(join(tmpdir(), 'demo-race-'));
  const round = {
    root,
    id: 'race',
    phase: 'provisioned',
    config: { root },
  } as unknown as import('../../tools/demo/round.js').DemoRound;
  const c = new DemoControl(round, {
    stop: async () => false,
  });
  try {
    await c.arm();
    c.report('observed during startup');
    c.bindRun('run-1');
    expect(() => c.bindRun('run-2')).toThrow('already bound');
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
    phase: 'provisioned',
    config: { root },
  } as unknown as import('../../tools/demo/round.js').DemoRound;
  const c = new DemoControl(round, { stop: async () => true });
  try {
    const s = await c.arm(5000);
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

