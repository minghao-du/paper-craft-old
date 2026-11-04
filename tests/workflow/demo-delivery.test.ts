import { test, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoDelivery } from '../../tools/demo/delivery.js';
import type { DemoRound } from '../../tools/demo/round.js';
import { updateRunRegistry } from '../../packages/core/src/workflow/run/run-driver.js';
import { loadFleetConfig } from '../../packages/core/src/workflow/fleet/fleet-config.js';

test('reconnected human consent cannot confirm a changed delivery and gate preserves native prerequisites', async () => {
  const root = mkdtempSync(join(tmpdir(), 'demo-delivery-'));
  let firstReleased = true;
  let version = 'one',
    valid = true;
  const configPath = join(root, '.epic-config.json');
  writeFileSync(configPath, JSON.stringify({
    clone_root: '.',
    local_worktrees: true,
  }));
  writeFileSync(join(root, 'control.json'), JSON.stringify({
    armed: true,
    stopped: false,
    releasing: false,
    activeMs: 0,
    budgetMs: 100000,
  }));
  const round = { id: 'demo-delivery-round', root, workflowConfigFile: configPath } as DemoRound;
  updateRunRegistry(loadFleetConfig(configPath), (reg) => {
    reg.runs.push({
      id: 'run-demo',
      provider: 'agy',
      subject: { repository: 'o/r', number: 1, kind: 'epic' },
      orchestratorId: 'orch-1',
      lifecycle: 'running',
      constraints: {
        kind: 'demo',
        roundId: round.id,
      },
      brief: { path: join(root, 'brief.md') },
    });
  });
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
    const controlPath = join(root, 'control.json');
    const resetControl = () =>
      writeFileSync(
        controlPath,
        JSON.stringify({
          armed: true,
          stopped: false,
          releasing: false,
          activeMs: 0,
          budgetMs: 100000,
        }),
      );
    const delivery = new DemoDelivery(round, adapter);
    valid = false;
    await expect(delivery.gate('worker1')).rejects.toThrow();
    resetControl();
    valid = true;
    firstReleased = false;
    await expect(delivery.gate('worker2')).rejects.toThrow();
    resetControl();
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
