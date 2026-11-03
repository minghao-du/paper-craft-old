import { test, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DemoFinalization } from '../../packages/core/src/workflow/demo/finalization.js';
import type { DemoRound } from '../../packages/core/src/workflow/demo/round.js';

test('demo publication blocks unclosed or changes-needed delivery and confines coordinator destination', async () => {
  const root = mkdtempSync(join(tmpdir(), 'demo-finalization-'));
  const round = {
    root,
    entry: join(root, 'report.md'),
    config: { coordinator: 'operator', brief: 'bounded report' },
  } as DemoRound;
  let closed = false,
    accepted = false,
    published = 0;
  const adapter = {
    async inspect() {
      return { closed, pipelineAccepted: accepted };
    },
    async pipeline() {
      accepted = true;
    },
    async publish() {
      published++;
      return { path: round.entry };
    },
  };
  try {
    const service = new DemoFinalization(round, adapter);
    await expect(service.pipeline()).rejects.toThrow('closure');
    closed = true;
    await expect(service.publish()).rejects.toThrow('Pipeline');
    expect(published).toBe(0);
    await service.pipeline();
    expect(await service.publish()).toEqual({ path: round.entry });
    expect(published).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
