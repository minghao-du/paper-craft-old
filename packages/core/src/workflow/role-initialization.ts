/** Durable role initialization, separate from native conversation/delivery acknowledgement. */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ManagedAttempt } from './runtime.js';

/** Expectations copied from the owning Run/Dispatch, never inferred from model output. */
export interface RoleInitialization {
  run: string;
  registry: string;
  authority: string;
  subject: string;
  role: ManagedAttempt['role'];
  attempt: string;
  revision?: string;
  briefHash: string;
  context: { path: string; hash: string };
}
const workerPhases = [
  'exploring',
  'coding',
  'testing',
  'awaiting-results',
  'quality-gate',
  'needs-human',
  'completed',
];
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Append the one authoritative startup evidence instruction to a complete brief. */
export function initializationInstructions(
  expected: RoleInitialization,
  directory: string,
): string {
  return `\nRole initialization gate: read the immutable context at ${expected.context.path}. Initialize your assigned role before proceeding. Write ${join(directory, 'initialization.json')} atomically with these exact assignment fields: ${JSON.stringify(expected)}. These fields acknowledge role/scope and the exact context you initialized; they are not a task completion receipt. For worker, also write actual checkout .epic-status.json (matching issue, phase from ${workerPhases.join(', ')}, nonempty summary, UTC updated_at at or after launch) and append a timestamped startup entry containing this Attempt id to .epic-worklog.md. Never claim ready without these files.\n`;
}

/** Verify the assignment-bound evidence and existing role artifacts; missing facts stay pending. */
export function verifyRoleInitialization(attempt: ManagedAttempt): string {
  const expected = attempt.initialization;
  if (!expected) throw new Error('Missing Run-derived role initialization expectations');
  const path = join(attempt.directory, 'initialization.json');
  const claim = JSON.parse(readFileSync(path, 'utf8')) as RoleInitialization;
  for (const key of [
    'run',
    'registry',
    'authority',
    'subject',
    'role',
    'attempt',
    'revision',
    'briefHash',
  ] as const)
    if (claim[key] !== expected[key]) throw new Error(`Role initialization ${key} mismatch`);
  if (
    claim.context?.path !== expected.context.path ||
    claim.context.hash !== expected.context.hash ||
    digest(readFileSync(expected.context.path, 'utf8')) !== expected.context.hash
  )
    throw new Error('Role initialization context changed or missing');
  if (statSync(path).mtimeMs < Date.parse(attempt.created))
    throw new Error('Role initialization evidence predates this Attempt');
  const registry = JSON.parse(readFileSync(expected.registry, 'utf8'));
  const run = registry.runs.find((r: { id: string }) => r.id === expected.run);
  if (!run) throw new Error('Role initialization has no owning Run');
  if (
    run.orchestratorId !== expected.authority ||
    (attempt.role === 'orchestrator' && !attempt.dispatchId && expected.authority !== attempt.id)
  )
    throw new Error('Orchestrator initialization lacks registered authority');
  if (
    attempt.role === 'epic' &&
    `${run.subject.repository}#${run.subject.number}` !== expected.subject &&
    !registry.subjects?.some(
      (s: { subject: string; ownerRunId: string }) =>
        s.subject === expected.subject && s.ownerRunId === expected.run,
    )
  )
    throw new Error('EPIC initialization scope is outside its Run');
  if (attempt.role === 'worker') {
    const status = JSON.parse(readFileSync(join(attempt.checkout, '.epic-status.json'), 'utf8'));
    const issue = Number(expected.subject.split('#').at(-1));
    if (
      status.issue !== issue ||
      !workerPhases.includes(status.phase) ||
      typeof status.summary !== 'string' ||
      !status.summary.trim() ||
      !Number.isFinite(Date.parse(status.updated_at)) ||
      Date.parse(status.updated_at) < Date.parse(attempt.created)
    )
      throw new Error('Worker status must identify this assignment with fresh actual state');
    const worklog = readFileSync(join(attempt.checkout, '.epic-worklog.md'), 'utf8');
    if (!worklog.split('\n').some((line) => /startup/i.test(line) && line.includes(attempt.id)))
      throw new Error('Worker startup worklog entry missing for this Attempt');
  }
  if (attempt.role === 'landing') {
    const owner = JSON.parse(readFileSync(join(attempt.checkout, '.pc-execution-owner'), 'utf8'));
    if (owner.runId !== expected.run) throw new Error('Landing checkout ownership mismatch');
  }
  return `Verified ${attempt.role} initialization: ${path}`;
}

/** Native adapters wait for supplied managed-role expectations without issuing more prompts. */
export function roleInitializationReady(attempt: ManagedAttempt): boolean {
  if (!attempt.initialization) return true;
  try {
    verifyRoleInitialization(attempt);
    return true;
  } catch {
    return false;
  }
}
