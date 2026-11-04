/** Durable role initialization, separate from native conversation/delivery acknowledgement. */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ManagedAttempt } from '../runtime/runtime.js';

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
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Required role artifacts, shared by inline and file-based startup instructions. */
export function roleArtifactInstructions(_expected: RoleInitialization): string {
  return '';
}

/** Append the one authoritative startup evidence instruction to a complete brief. */
export function initializationInstructions(
  expected: RoleInitialization,
  directory: string,
): string {
  return `\nRole initialization gate: read the immutable context at ${expected.context.path}. Initialize your assigned role before proceeding. Write ${join(directory, 'initialization.json')} atomically with these exact assignment fields: ${JSON.stringify(expected)}. These fields acknowledge role/scope and the exact context you initialized; they are not a task completion receipt. ${roleArtifactInstructions(expected)} Never claim ready without these files.\n`;
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

/** Refresh startup identity and activation committed by the background helper for a held Attempt. */
export function refreshStartupAttempt(attempt: ManagedAttempt): void {
  if (!attempt.startupGate || !attempt.initialization) return;
  const registry = JSON.parse(readFileSync(attempt.initialization.registry, 'utf8'));
  const run = registry.runs.find((r: { id: string }) => r.id === attempt.run);
  const current =
    run?.orchestratorId === attempt.id
      ? run.orchestrator
      : registry.dispatches
          ?.find((d: { id: string }) => d.id === attempt.dispatchId)
          ?.attempts.at(-1);
  if (run?.lifecycle === 'running' && current?.id === attempt.id)
    Object.assign(attempt, {
      activation: current.activation,
      conversation: current.conversation,
      address: current.address,
      evidence: current.evidence,
      status: current.status,
    });
}
