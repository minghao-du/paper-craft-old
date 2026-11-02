/** Fixed CLI boundary inputs shared by output baseline and regression checks. */
export function outputRegistry() {
  const brief = 'IMMUTABLE-BRIEF-BODY '.repeat(200);
  const attempt = {
    id: 'attempt-current',
    fleet: 'fleet',
    run: 'run-1',
    role: 'orchestrator',
    runner: 'agy',
    brief,
    status: 'unknown',
    created: '2026-01-01T00:00:00Z',
    directory: '/runtime/current',
    checkout: '/project',
    observation: { status: 'unknown', evidence: 'Cannot establish occupancy' },
  };
  const run = {
    id: 'run-1',
    subject: { repository: 'org/repo', number: 7, title: 'Delivery', body: brief, kind: 'issue' },
    provider: 'agy',
    policy: { name: 'default', revision: 1 },
    lifecycle: 'blocked',
    orchestratorId: 'attempt-current',
    orchestrator: attempt,
    brief: { path: '/runtime/context.md', hash: 'context-hash' },
    requirements: brief,
    reconciliation: {
      at: '2026-01-01T00:00:00Z',
      blockers: ['Occupancy unknown'],
      pendingDispatches: ['pending-0'],
    },
    priorOrchestrators: [{ ...attempt, id: 'old', brief: 'HANDLED-HISTORY '.repeat(100) }],
  };
  const dispatch = {
    runId: 'run-1',
    authority: 'attempt-current',
    subject: 'org/repo#7',
    role: 'worker',
    stage: 'implementation',
    inputRevision: 'revision-1',
    brief,
    prerequisites: [],
    id: 'pending-0',
    generation: 1,
    provider: 'agy',
    briefReference: { path: '/runtime/brief-0.md', hash: 'brief-hash' },
    attempts: [{ ...attempt, id: 'worker-0', role: 'worker', dispatchId: 'pending-0' }],
    lifecycle: 'reported',
  };
  const receipt = {
    id: 'receipt-0',
    dispatchId: 'pending-0',
    attemptId: 'worker-0',
    runId: 'run-1',
    subject: 'org/repo#7',
    role: 'worker',
    stage: 'implementation',
    provider: 'agy',
    inputRevision: 'revision-1',
    outcome: 'completed',
    evidence: [{ path: '/runtime/result-0.json', hash: 'result-hash' }],
  };
  return {
    ...{
      revision: 8,
      runs: null,
      dispatches: null,
      receipts: null,
      resources: [{ path: '/checkout', runId: 'run-1', registry: '/runtime/registry.json' }],
      subjects: [{ subject: 'org/repo#7', ownerRunId: 'run-1', consumingRunIds: [] }],
      stageEvents: null,
      acknowledgements: [],
    },
    runs: [
      run,
      { ...run, id: 'run-2', provider: 'codex', orchestrator: null, orchestratorId: 'attempt-2' },
    ],
    dispatches: Array.from({ length: 35 }, (_, i) => ({
      ...dispatch,
      id: `pending-${i}`,
      attempts: [{ ...attempt, id: `worker-${i}`, role: 'worker', dispatchId: `pending-${i}` }],
      briefReference: { path: `/runtime/brief-${i}.md`, hash: 'brief-hash' },
    })),
    receipts: Array.from({ length: 35 }, (_, i) => ({
      ...receipt,
      id: `receipt-${i}`,
      dispatchId: `pending-${i}`,
      attemptId: `worker-${i}`,
      evidence: [{ path: `/runtime/result-${i}.json`, hash: 'result-hash' }],
    })),
    stageEvents: Array.from({ length: 35 }, (_, i) => ({
      receiptId: `receipt-${i}`,
      kind: 'reported',
    })),
  };
}
