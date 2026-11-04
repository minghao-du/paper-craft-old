import { test, expect } from 'vitest';
import {
  realpathSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DemoDisposition, type DemoDisposalAdapter } from '../../tools/demo/disposition.js';
import type { DemoRound } from '../../tools/demo/round.js';
import type { DemoVerification } from '../../tools/demo/verifier.js';

let nextRepoId = 1000;
function createMockRound(root: string, id: string = randomUUID(), baseline = 'demo-baseline-1'): DemoRound {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  const repoId = ++nextRepoId;
  const round: DemoRound = {
    id,
    phase: 'provisioned',
    provider: 'agy',
    config: {
      root,
      owner: 'test-org',
      prefix: 'demo-',
      coordinator: 'coordinator-identity',
      brief: 'Test brief',
    },
    baseline,
    root: dir,
    checkout: join(dir, 'checkout'),
    worktrees: join(dir, 'worktrees'),
    state: join(dir, 'state'),
    research: join(dir, 'research'),
    entry: join(dir, 'research', 'report.md'),
    repository: { id: repoId, owner: 'test-org', name: `demo-${id}` },
    parent: 42,
  };
  writeFileSync(join(dir, 'round.json'), JSON.stringify(round, null, 2));
  return round;
}

test('completed-but-live execution is released before reverification/deletion', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-live-release-')));
  try {
    const round = createMockRound(root);
    let live = true;
    let releaseCalled = false;
    let verifyCalledAfterRelease = false;
    let repoDeleted = false;
    let localDeleted = false;

    const adapter: DemoDisposalAdapter = {
      async release(_r) {
        releaseCalled = true;
        live = false;
        return true;
      },
      async released(_r) {
        return !live;
      },
      async verify(_r): Promise<DemoVerification> {
        if (releaseCalled) {
          verifyCalledAfterRelease = true;
        }
        return {
          source: 'controlled',
          references: [round.root],
          checks: [],
          boundary: 'final',
          checksNotRun: [],
          limitations: [],
          business: 'completed',
          defects: 'clear',
          execution: live ? 'unknown' : 'released',
          cleanup: 'pending',
          clean: !live,
        };
      },
      async repository(_r) {
        return repoDeleted ? null : round.repository!;
      },
      async removeRepository(_r, beforeDelete) {
        beforeDelete?.();
        repoDeleted = true;
      },
      async removeLocal(_r) {
        localDeleted = true;
        rmSync(round.root, { recursive: true, force: true });
      },
      display(_result) {},
    };

    const d = new DemoDisposition(adapter);
    const outcome = await d.finish(round);

    expect(releaseCalled).toBe(true);
    expect(verifyCalledAfterRelease).toBe(true);
    expect(repoDeleted).toBe(true);
    expect(localDeleted).toBe(true);
    expect(outcome.cleanup).toBe('completed');
    expect(outcome.success).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clean success survives release and avoids user-stop classification', async () => {
  const { DemoControl } = await import('../../tools/demo/control.js');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-clean-release-')));
  try {
    const round = createMockRound(root);
    writeFileSync(
      join(round.root, 'control.json'),
      JSON.stringify({
        runId: 'run-completed-1',
        started: 1000,
        tick: 1000,
        budgetMs: 3600000,
        activeMs: 5000,
        stopped: false,
        execution: 'running',
        observations: [],
        usage: 'unavailable',
      }),
    );

    let stopCompletedFlag: boolean | undefined;
    const execution = {
      async stop(_r: DemoRound, _runId?: string, completed?: boolean) {
        stopCompletedFlag = completed;
        return true;
      },
    };

    const control = new DemoControl(round, execution);
    const releaseState = await control.release();

    // Verify stop was called with completed=true (normal releaseRun path)
    expect(stopCompletedFlag).toBe(true);
    // Control state preserves stopped=false (not classified as user stop)
    expect(releaseState.stopped).toBe(false);
    expect(releaseState.stoppedReason).toBeUndefined();
    expect(releaseState.execution).toBe('released');

    // Now test disposition with this clean control state
    let repoDeleted = false;
    const adapter: DemoDisposalAdapter = {
      async release(_r) {
        await control.release();
        return true;
      },
      async released(_r) {
        return control.status().execution === 'released';
      },
      async verify(_r): Promise<DemoVerification> {
        return {
          source: 'controlled',
          references: [round.root],
          checks: [],
          boundary: 'final',
          checksNotRun: [],
          limitations: [],
          business: 'completed',
          defects: 'clear',
          execution: control.status().execution === 'released' ? 'released' : 'unknown',
          cleanup: 'pending',
          clean: true,
        };
      },
      async repository(_r) {
        return repoDeleted ? null : round.repository!;
      },
      async removeRepository(_r, beforeDelete) {
        beforeDelete?.();
        repoDeleted = true;
      },
      async removeLocal(_r) {
        rmSync(round.root, { recursive: true, force: true });
      },
      display(_result) {},
    };

    const d = new DemoDisposition(adapter);
    const res = await d.finish(round);
    expect(res.cleanup).toBe('completed');
    expect(res.success).toBe(true);
    expect(repoDeleted).toBe(true);
    expect(existsSync(round.root)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('late observations, identity changes, and unknown release retain the scene', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-retains-')));
  try {
    const round = createMockRound(root);
    let lateObservation = false;
    let repoDeleted = false;
    let releasedOk = true;
    let returnedRepo = round.repository!;

    const baseResult: DemoVerification = {
      source: 'controlled',
      references: [round.root],
      checks: [],
      boundary: 'final',
      checksNotRun: [],
      limitations: [],
      business: 'completed',
      defects: 'clear',
      execution: 'released',
      cleanup: 'pending',
      clean: true,
    };

    const adapter: DemoDisposalAdapter = {
      async release(_r) {
        return true;
      },
      async released(_r) {
        return releasedOk;
      },
      async verify(_r) {
        return baseResult;
      },
      async repository(_r) {
        return repoDeleted ? null : returnedRepo;
      },
      async removeRepository(_r, beforeDelete) {
        beforeDelete?.();
        repoDeleted = true;
      },
      async removeLocal(_r) {
        rmSync(round.root, { recursive: true, force: true });
      },
      display(_r) {
        if (lateObservation) {
          writeFileSync(
            join(round.root, 'control.json'),
            JSON.stringify({
              stopped: false,
              observations: [{ id: 'late-1', text: 'Late observation during display' }],
            }),
          );
        }
      },
    };

    const d = new DemoDisposition(adapter);

    // 1. Unknown release retains the scene
    releasedOk = false;
    const unknownReleaseOutcome = await d.finish(round);
    expect(unknownReleaseOutcome.cleanup).toBe('retained');
    expect(unknownReleaseOutcome.reason).toContain('Execution or helper occupancy unknown');
    expect(repoDeleted).toBe(false);
    expect(existsSync(round.root)).toBe(true);

    // Clean up disposition.json for next check
    if (existsSync(join(round.root, 'disposition.json'))) {
      rmSync(join(round.root, 'disposition.json'));
    }

    // 2. Late observation retains the scene
    releasedOk = true;
    lateObservation = true;
    const lateObsOutcome = await d.finish(round);
    expect(lateObsOutcome.cleanup).toBe('retained');
    expect(repoDeleted).toBe(false);
    expect(existsSync(round.root)).toBe(true);

    lateObservation = false;
    if (existsSync(join(round.root, 'disposition.json'))) {
      rmSync(join(round.root, 'disposition.json'));
    }
    if (existsSync(join(round.root, 'control.json'))) {
      rmSync(join(round.root, 'control.json'));
    }

    // 3. Remote identity change fails and retains the scene
    returnedRepo = { id: 9999, owner: 'other-owner', name: 'demo-foreign' };
    const mismatchOutcome = await d.finish(round);
    expect(mismatchOutcome.cleanup).toBe('failed');
    expect(mismatchOutcome.reason).toContain('Remote repository identity changed');
    expect(repoDeleted).toBe(false);
    expect(existsSync(round.root)).toBe(true);

    if (existsSync(join(round.root, 'disposition.json'))) {
      rmSync(join(round.root, 'disposition.json'));
    }
    returnedRepo = round.repository!;

    // 4. Remote deletion failure reconciles and retains local evidence without blind retry
    const origRemove = adapter.removeRepository;
    adapter.removeRepository = async (_r, _before) => {
      throw new Error('GitHub API 403 Forbidden: repository deletion policy disabled');
    };
    const failedDeletionOutcome = await d.finish(round);
    expect(failedDeletionOutcome.cleanup).toBe('failed');
    expect(failedDeletionOutcome.reason).toContain('Repository deletion uncertain');
    expect(existsSync(round.root)).toBe(true);
    adapter.removeRepository = origRemove;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fresh-validation deletion keeps its evidence available until authorized cleanup finishes', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-fresh-auth-')));
  try {
    const defectiveRound = createMockRound(root, undefined, 'pinned-baseline-xyz');
    const freshRound = createMockRound(root, undefined, 'pinned-baseline-xyz');

    let defectiveDeleted = false;
    let freshDeleted = false;

    const adapter: DemoDisposalAdapter = {
      async release(_r) {
        return true;
      },
      async released(_r) {
        return true;
      },
      async verify(r): Promise<DemoVerification> {
        const isFresh = r.id === freshRound.id;
        return {
          source: 'controlled',
          references: [r.root],
          checks: isFresh
            ? []
            : [
                {
                  stage: 'artifacts',
                  expected: 'PR 1 generator and test',
                  observed: 'Generator failed with exit code 1',
                  verdict: 'finding',
                },
              ],
          boundary: 'final',
          checksNotRun: [],
          limitations: [],
          business: 'completed',
          defects: isFresh ? 'clear' : 'findings',
          execution: 'released',
          cleanup: 'pending',
          clean: isFresh,
        };
      },
      async repository(r) {
        if (r.id === defectiveRound.id) {
          return defectiveDeleted ? null : defectiveRound.repository!;
        }
        return freshDeleted ? null : freshRound.repository!;
      },
      async removeRepository(r, beforeDelete) {
        beforeDelete?.();
        if (r.id === defectiveRound.id) {
          defectiveDeleted = true;
        } else {
          freshDeleted = true;
        }
      },
      async removeLocal(r) {
        if (r.id === defectiveRound.id) {
          rmSync(defectiveRound.root, { recursive: true, force: true });
        } else {
          rmSync(freshRound.root, { recursive: true, force: true });
        }
      },
      display(_r) {},
    };

    const d = new DemoDisposition(adapter);

    // 1. Without authorization, defective round is retained
    const unauthOutcome = await d.finish(defectiveRound);
    expect(unauthOutcome.cleanup).toBe('retained');
    expect(unauthOutcome.reason).toContain('Problems require fresh validation and explicit deletion confirmation');
    expect(defectiveDeleted).toBe(false);
    expect(existsSync(defectiveRound.root)).toBe(true);

    // Clear disposition.json for subsequent attempt
    if (existsSync(join(defectiveRound.root, 'disposition.json'))) {
      rmSync(join(defectiveRound.root, 'disposition.json'));
    }

    // 2. Reject authorization if baseline differs
    const mismatchedBaselineRound = createMockRound(root, undefined, 'different-baseline');
    await expect(
      d.finish(defectiveRound, {
        fresh: mismatchedBaselineRound,
        forceDefective: true,
      }),
    ).resolves.toMatchObject({
      cleanup: 'failed',
      reason: expect.stringContaining('Expected different fresh validation round with equivalent baseline'),
    });

    if (existsSync(join(defectiveRound.root, 'disposition.json'))) {
      rmSync(join(defectiveRound.root, 'disposition.json'));
    }

    // 3. Reject authorization if fresh round is the same round
    await expect(
      d.finish(defectiveRound, {
        fresh: defectiveRound,
        forceDefective: true,
      }),
    ).resolves.toMatchObject({
      cleanup: 'failed',
      reason: expect.stringContaining('Expected different fresh validation round with equivalent baseline'),
    });

    if (existsSync(join(defectiveRound.root, 'disposition.json'))) {
      rmSync(join(defectiveRound.root, 'disposition.json'));
    }

    // 4. Authorized cleanup of defective round:
    // - Requires forceDefective: true and authorized-by-fresh-round
    // - Keeps fresh evidence available before, during, and after defective deletion
    // - Does NOT delete fresh round
    // - Does NOT turn defective round outcome into success (success remains false)
    const authOutcome = await d.finish(defectiveRound, {
      fresh: freshRound,
      forceDefective: true,
    });

    expect(authOutcome.cleanup).toBe('completed');
    expect(authOutcome.success).toBe(false); // Cleanliness of defective round was false! Not turned into success!
    expect(defectiveDeleted).toBe(true);
    expect(existsSync(defectiveRound.root)).toBe(false);

    // Fresh round evidence remains intact and was NOT deleted
    expect(freshDeleted).toBe(false);
    expect(existsSync(freshRound.root)).toBe(true);
    expect(existsSync(join(freshRound.root, 'round.json'))).toBe(true);
    const freshRoundContent = JSON.parse(readFileSync(join(freshRound.root, 'round.json'), 'utf8'));
    expect(freshRoundContent.id).toBe(freshRound.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fresh validation evidence must remain present before scene deletion', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-fresh-disappear-')));
  try {
    const defectiveRound = createMockRound(root, undefined, 'baseline-common');
    const freshRound = createMockRound(root, undefined, 'baseline-common');

    let repoDeleted = false;
    const adapter: DemoDisposalAdapter = {
      async release(_r) {
        return true;
      },
      async released(_r) {
        return true;
      },
      async verify(r): Promise<DemoVerification> {
        const isFresh = r.id === freshRound.id;
        return {
          source: 'controlled',
          references: [r.root],
          checks: [],
          boundary: 'final',
          checksNotRun: [],
          limitations: [],
          business: 'completed',
          defects: isFresh ? 'clear' : 'findings',
          execution: 'released',
          cleanup: 'pending',
          clean: isFresh,
        };
      },
      async repository(r) {
        return repoDeleted ? null : r.repository!;
      },
      async removeRepository(_r, beforeDelete) {
        beforeDelete?.();
        repoDeleted = true;
        // Simulate fresh round being deleted before defective round local deletion finishes
        rmSync(freshRound.root, { recursive: true, force: true });
      },
      async removeLocal(r) {
        rmSync(r.root, { recursive: true, force: true });
      },
      display(_r) {},
    };

    const d = new DemoDisposition(adapter);
    const outcome = await d.finish(defectiveRound, {
      fresh: freshRound,
      forceDefective: true,
    });

    expect(outcome.cleanup).toBe('failed');
    expect(outcome.reason).toContain('Fresh validation evidence missing before scene deletion');
    expect(existsSync(defectiveRound.root)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI surfaces: dispose options and obsolete create-children removal', async () => {
  const { createDemoProgram } = await import('../../tools/demo/cli.js');

  const demoCmd = createDemoProgram();
  expect(demoCmd).toBeDefined();

  // Obsolete direct business entry point create-children must be removed
  const createChildrenCmd = demoCmd.commands.find((c) => c.name() === 'create-children');
  expect(createChildrenCmd).toBeUndefined();

  // Dispose command must have --force-defective and --authorized-by-fresh-round
  const disposeCmd = demoCmd.commands.find((c) => c.name() === 'dispose');
  expect(disposeCmd).toBeDefined();

  const optionNames = disposeCmd!.options.map((o) => o.long);
  expect(optionNames).toContain('--force-defective');
  expect(optionNames).toContain('--authorized-by-fresh-round');
  expect(optionNames).not.toContain('--validated-by');
  expect(optionNames).not.toContain('--confirm-resolved');
});

