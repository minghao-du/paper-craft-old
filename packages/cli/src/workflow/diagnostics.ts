/** Trace concise command errors through existing Runtime storage without changing business results. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { stateDirectory } from '@paper-craft/core/workflow/handoff';
import type { FleetConfig } from '@paper-craft/core/workflow/fleet-config';

/** Keep actionable error text while removing the audited terminal suffix. */
export function conciseError(error: string): string {
  if (/^(?:Error: )?agy capability probe failed:/i.test(error))
    return 'agy capability probe failed; inspect diagnostics and authentication/configuration';
  const terminal = error.match(/^([\s\S]*? at tmux:[^\s:]+):[\s\S]+$/);
  return terminal ? terminal[1] : error;
}

/** Invocation association is diagnostic metadata, never Acceptance evidence. */
export interface DiagnosticContext {
  command: string;
  run?: string;
  attempt?: string;
  subject?: string;
}

/** Reuse readable authoritative errors, otherwise save only the hidden diagnostic. */
export function diagnosticError(
  config: FleetConfig | undefined,
  error: string | undefined,
  context: DiagnosticContext,
  persist = true,
) {
  if (!error) return {};
  const concise = conciseError(error);
  if (concise === error) return { error };
  if (!config)
    return { error: concise, diagnosticSaveError: 'No validated Fleet storage available' };
  try {
    // Queries must not create snapshots or directories merely to reference an existing error.
    const hash = createHash('sha256').update(config.file).digest('hex');
    const registry = join(config.root, '.runtime', hash, 'registry.json');
    try {
      if (!lstatSync(registry).isFile()) throw new Error('Expected regular Registry file');
      const saved = JSON.parse(readFileSync(registry, 'utf8')) as {
        runs?: { id: string; orchestrator?: { id: string; error?: string } }[];
      };
      const run = saved.runs?.find((entry) => entry.id === context.run);
      if (run?.orchestrator?.id === context.attempt && run?.orchestrator?.error === error) {
        // Validate parent components using the same configured-root guard as writes.
        stateDirectory(config, '.runtime', hash);
        return {
          error: concise,
          diagnostics: [{ path: registry, run: context.run, attempt: context.attempt }],
        };
      }
    } catch {
      /* Unsaved errors need invocation-associated storage below. */
    }
    if (context.run && /^[a-zA-Z0-9-]+$/.test(context.run)) {
      try {
        const path = join(config.root, '.runtime', hash, `orchestrator-${context.run}.json`);
        if (!lstatSync(path).isFile()) throw new Error('Expected regular Attempt file');
        const saved = JSON.parse(readFileSync(path, 'utf8'));
        if (saved.id === context.attempt && saved.run === context.run && saved.error === error) {
          stateDirectory(config, '.runtime', hash);
          return {
            error: concise,
            diagnostics: [{ path, run: context.run, attempt: context.attempt }],
          };
        }
      } catch {
        /* No verified current Attempt diagnostic. */
      }
    }
    if (!persist)
      return {
        error: concise,
        diagnosticSaveError: 'Original diagnostic is not readable in Registry',
      };
    const home = stateDirectory(config, '.runtime', hash);
    const invocation = randomUUID();
    const path = join(home, `diagnostic-${invocation}.json`);
    const sanitized = error
      .replace(/\b(Bearer\s+)\S+/gi, '$1[redacted]')
      .replace(
        /\b((?:[a-z0-9_-]*(?:api[_-]?key|token|password|secret))\s*[:=]\s*)[^\s,;]+/gi,
        '$1[redacted]',
      );
    const body = JSON.stringify({ invocation, ...context, error: sanitized });
    writeFileSync(path, body, { flag: 'wx', mode: 0o600 });
    if (readFileSync(path, 'utf8') !== body)
      throw new Error('Diagnostic readability verification failed');
    return { error: concise, diagnostics: [{ path, invocation, ...context }] };
  } catch (failure) {
    return {
      error: concise,
      diagnosticSaveError: failure instanceof Error ? failure.message : String(failure),
    };
  }
}
