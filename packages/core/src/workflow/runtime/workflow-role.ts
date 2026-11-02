/** Roles assigned by the owning workflow, independent of task names and progress. */
export const workflowRoles = [
  'orchestrator',
  'worker',
  'epic',
  'landing',
  'pipeline-audit',
  'pipeline-refactor',
  'research-state',
] as const;
/** A persistent workflow responsibility. */
export type WorkflowRole = (typeof workflowRoles)[number];

/** Reject untrusted record values rather than inferring responsibility from labels. */
export function assertWorkflowRole(role: unknown, source: string): asserts role is WorkflowRole {
  if (!workflowRoles.some((allowed) => allowed === role))
    throw new Error(
      `${source}: expected role ${workflowRoles.join('|')}; received ${JSON.stringify(role)}. Resolve the assignment from its owning workflow.`,
    );
}

/** Delivery stages have fixed responsibilities; other assignments belong to the Orchestrator. */
export function assertStageRole(
  stage: string,
  role: unknown,
  source: string,
): asserts role is WorkflowRole {
  assertWorkflowRole(role, source);
  const assignments: Record<string, WorkflowRole> = {
    'integrated-acceptance': 'epic',
    'pipeline-audit': 'pipeline-audit',
    'pipeline-refactor': 'pipeline-refactor',
    'research-report': 'research-state',
    implementation: 'worker',
    'pr-repair': 'worker',
    'final-records': 'worker',
    'pr-quality': 'landing',
    'pr-merge': 'landing',
    'preservation-cleanup': 'landing',
  };
  const businessRole = workflowRoles.find(
    (candidate) =>
      stage.startsWith(`business-${candidate}-`) &&
      /^[a-f0-9]{16}$/.test(stage.slice(`business-${candidate}-`.length)),
  );
  const expected = Object.hasOwn(assignments, stage) ? assignments[stage] : businessRole;
  if (expected && role !== expected)
    throw new Error(
      `${source}: workflow stage ${stage} requires role ${expected}; received ${role}`,
    );
}
