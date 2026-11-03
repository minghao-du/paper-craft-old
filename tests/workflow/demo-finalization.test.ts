import { test, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DemoFinalization, type DemoFinalizationView } from '../../packages/core/src/workflow/demo/finalization.js';
import type { DemoRound } from '../../packages/core/src/workflow/demo/round.js';

test('demo finalization provides stable public view and records boundary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'demo-finalization-'));
  const round = {
    id: 'round-1',
    root,
    entry: join(root, 'report.md'),
    config: { coordinator: 'operator', brief: 'bounded report' },
  } as DemoRound;

  const mockView: DemoFinalizationView = {
    roundId: 'round-1',
    closed: true,
    epicClosure: {
      head: '1234',
      deliveryVersion: 'dv-1',
      evidence: 'evidence',
      confirmed: 'consent',
      status: 'closed',
    },
    pipeline: {
      disposition: 'completed_no_changes',
      head: '1234',
      inspectedVersions: { repository: '1234' },
      accepted: true,
    },
    report: {
      path: round.entry,
      hash: 'hash-abc',
      published: true,
      acceptedVersions: { integrated: '1234' },
      observedVersions: { integrated: '1234' },
    },
    businessCompleted: true,
  };

  const adapter = {
    async inspect() {
      return mockView;
    },
  };

  try {
    const service = new DemoFinalization(round, adapter);
    const view = await service.view();
    expect(view).toEqual(mockView);

    const log = readFileSync(join(root, 'finalization-boundaries.jsonl'), 'utf8');
    expect(log).toContain('finalization-view');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
