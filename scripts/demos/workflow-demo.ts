/** Run the shared isolated controlled workflow scenario; retain all toy evidence. */
import { runAllRoleDemo } from '../../tests/workflow/scripted-epic-demo.js';
import { inspectRuns } from '../../packages/core/src/workflow/run/run-registry.js';
const result = await runAllRoleDemo();
const registry = inspectRuns(result.config);
console.log(
  JSON.stringify(
    {
      outcome: 'completed',
      evidenceDirectory: result.directory,
      run: result.run.id,
      planning: result.planning,
      implementation: result.implementation,
      cleanup: result.cleanup,
      archive: result.archive,
      report: result.report,
      roles: [...new Set(['orchestrator', ...registry.dispatches!.map((d) => d.role)])],
      accepted: registry
        .dispatches!.filter((d) => d.lifecycle === 'accepted')
        .map((d) => ({ role: d.role, stage: d.stage, receipt: d.acceptedReceipt })),
      resourceOccupancy: registry.resources,
      terminationEvidence: [...result.terminated],
      evidenceLevel: result.evidenceLevel,
    },
    null,
    2,
  ),
);
