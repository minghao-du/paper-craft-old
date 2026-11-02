import { join } from 'node:path';
import { roleArtifactInstructions } from '../run/role-initialization.js';
import type { ManagedAttempt } from './runtime.js';

/** Render AGY startup steps; task content remains in the referenced files. */
export function buildAgyStartupDocument(attempt: ManagedAttempt, assignmentPath: string): string {
  const initialization = attempt.initialization;
  const contextPath = initialization?.context.path;
  const steps = [
    `Read the complete assigned context at ${JSON.stringify(contextPath ?? assignmentPath)} once. Initialize the ${attempt.role} role using applicable project/role instructions and durable state.`,
    ...(contextPath && contextPath !== assignmentPath
      ? [
          `Read the current Attempt instructions at ${JSON.stringify(assignmentPath)}. Reconcile durable results before continuing; do not repeat completed or accepted work.`,
        ]
      : []),
    ...(attempt.role === 'orchestrator'
      ? ["Read pc-orchestrator's managed branch and its agy reference."]
      : []),
    ...(initialization
      ? [
          `Write ${JSON.stringify(join(attempt.directory, 'initialization.json'))} atomically with the exact JSON payload below. It acknowledges role/scope and context initialization, not task completion.`,
          roleArtifactInstructions(initialization),
        ]
      : []),
    `After initialization and required evidence are complete, emit a separate assistant text line exactly [pc ready role=${attempt.role} attempt=${attempt.id}]. Never claim ready if initialization is blocked.`,
    attempt.startupGate
      ? 'End this turn immediately and await a separate activation message. Do not poll for activation, dispatch tasks or perform business work in this turn. Initialization evidence and required role state files may be written.'
      : 'Then perform only the assigned work.',
  ].filter(Boolean);
  return [
    '# Startup initialization',
    '',
    ...(attempt.startupGate
      ? ['This turn is for initialization only; task execution requires separate activation.', '']
      : []),
    '## Steps',
    '',
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    '',
    initialization ? '## Initialization payload' : '## Attempt identity',
    '',
    '```json',
    JSON.stringify(
      initialization ?? { run: attempt.run, role: attempt.role, attempt: attempt.id },
      null,
      2,
    ),
    '```',
    '',
    'Task content stays in the referenced files. After activation, continue from the context already read; reread only when needed to restore missing context.',
    '',
  ].join('\n');
}
