import { test, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoDelivery } from '../../packages/core/src/workflow/demo/delivery.js';
import type { DemoRound } from '../../packages/core/src/workflow/demo/round.js';

test('reconnected human consent cannot confirm a changed delivery and gate preserves native prerequisites', async () => {
  const root = mkdtempSync(join(tmpdir(), 'demo-delivery-'));
  let firstReleased = true;
  let version = 'one',
    valid = true;
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

    // Request presents current version
    const req1 = await delivery.request();
    expect(req1.version).toBe('one');

    // Confirm requires explicit true and matching version
    await expect(delivery.confirm('one', false)).rejects.toThrow();
    await expect(delivery.confirm('two', true)).rejects.toThrow();

    const consent1 = await delivery.confirm('one', true);
    expect(consent1.deliveryVersion).toBe('one');
    expect(consent1.source).toBe('human');

    // Changed delivery version invalidates previous request
    version = 'two';
    await expect(delivery.confirm('one', true)).rejects.toThrow();

    // Re-requesting with new version allows confirmation of new version
    const req2 = await delivery.request();
    expect(req2.version).toBe('two');
    const consent2 = await delivery.confirm('two', true);
    expect(consent2.deliveryVersion).toBe('two');

    // DemoDelivery does not expose actual close (routed through normal Workflow)
    expect((delivery as any).close).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
