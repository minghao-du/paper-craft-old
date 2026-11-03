import { test, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoDelivery } from '../../packages/core/src/workflow/demo/delivery.js';
import type { DemoRound } from '../../packages/core/src/workflow/demo/round.js';
test('reconnected human consent cannot close a changed delivery or bypass native dependency gates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'demo-delivery-'));
  let firstReleased = true;
  let version = 'one',
    valid = true,
    closed = false;
  const round = { root } as DemoRound;
  const adapter = {
    async inspect() {
      return {
        version,
        children: [1, 2],
        nativeDependency: valid,
        firstReleased,
        secondBaseline: true,
        accepted: true,
      };
    },
    async close() {
      closed = true;
    },
  };
  try {
    const delivery = new DemoDelivery(round, adapter);
    valid = false;
    await expect(delivery.gate('worker1')).rejects.toThrow();
    valid = true;
    firstReleased = false;
    await expect(delivery.gate('worker2')).rejects.toThrow();
    firstReleased = true;
    await delivery.gate('worker2');
    await delivery.request();
    await delivery.confirm('one', true);
    version = 'two';
    await expect(new DemoDelivery(round, adapter).close()).rejects.toThrow();
    expect(closed).toBe(false);
    await delivery.request();
    await delivery.confirm('two', true);
    await delivery.close();
    expect(closed).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
