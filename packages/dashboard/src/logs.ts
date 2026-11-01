/** Bounded on-demand log reads from registered task sources. */
import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { within } from '@paper-craft/core/workflow/fleet-config';
import { dashboardTaskSource } from '@paper-craft/core/workflow/dashboard';
import { observeRuntime, type RuntimeExecutor } from './runtime.js';
import type { DashboardTask } from '@paper-craft/core/workflow/dashboard';

/** Strip secret-bearing lines and private prompt blocks before disclosure. */
function sanitize(text: string): string {
  return text
    .replace(/<(?:prompt|system|user_prompt)>[\s\S]*$/gi, '[private prompt omitted]')
    .replace(
      /^.*(?:authorization|bearer\s|password|passwd|api[_-]?key|access[_-]?token|secret|private[_ -]?key|(?:system|user|initial)[_ -]?prompt).*$/gim,
      '[sensitive line omitted]',
    )
    .replace(/(?:gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{10,})/g, '[credential omitted]');
}
/** Read only a fixed worklog or reverified terminal. Runner transcripts lack safe identity. */
export async function readTaskLog(
  configFile: string,
  task: DashboardTask,
  kind: string,
  offset: number,
  run: RuntimeExecutor,
) {
  const base = { kind, readAt: new Date().toISOString(), offset };
  try {
    const { directory, log } = dashboardTaskSource(configFile, task);
    if (kind === 'runner')
      return {
        ...base,
        state: 'unknown',
        error: 'No safely verified Runner log capability; private transcripts are not exposed',
      };
    if (kind === 'terminal') {
      const runtime = await observeRuntime(directory, run);
      const pane = runtime.tmux.panes.filter((p) => !p.dead);
      if (runtime.error || pane.length !== 1)
        return {
          ...base,
          state: 'unknown',
          error: 'Expected exactly one currently verified terminal pane',
        };
      const text = await run('tmux', [
        'capture-pane',
        '-p',
        '-t',
        pane[0].id,
        '-S',
        '-200',
        '-E',
        '-1',
      ]);
      // Recheck after capture as recovered panes may have changed directories or identity.
      const verified = await observeRuntime(directory, run);
      if (!verified.tmux.panes.some((p) => p.id === pane[0].id && p.pid === pane[0].pid))
        return { ...base, state: 'unknown', error: 'Terminal identity changed during read' };
      return {
        ...base,
        state: 'read',
        source: `tmux ${pane[0].id}`,
        text: sanitize(text.slice(0, 16384)),
        nextOffset: null,
        detail:
          'Latest bounded terminal segment; recognized prompt/credential lines omitted. Prompt context before the captured window is unknown.',
      };
    }
    const source = log;
    const physical = await realpath(source);
    if (!within(dirname(source), physical)) throw new Error('Worklog escapes registered source');
    const file = await open(
      physical,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      const metadata = await file.stat();
      if (!metadata.isFile()) throw new Error('Expected regular worklog file');
      // Read bounded preceding context so pagination cannot reset prompt redaction.
      if (offset + 16384 > 1024 * 1024)
        throw new Error('Worklog context exceeds safe 1 MiB read bound');
      const buffer = Buffer.alloc(Math.min(metadata.size, offset + 16384));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const end = Math.min(bytesRead, offset + 16384);
      const prefix = buffer.subarray(0, Math.min(bytesRead, offset + 128)).toString('utf8');
      let consumed = end;
      let text: string;
      if (/<(?:prompt|system|user_prompt)>/i.test(prefix)) {
        text = '[private prompt omitted]';
      } else {
        let start = offset;
        if (start && buffer[start - 1] !== 10) {
          const newline = buffer.indexOf(10, start);
          start = newline >= 0 ? newline + 1 : end;
        }
        if (end < metadata.size && buffer[end - 1] !== 10) {
          const newline = buffer.lastIndexOf(10, end - 1);
          if (newline >= start) consumed = newline + 1;
          else {
            text = '[oversized log line omitted]';
            start = end;
          }
        }
        text ??= buffer.subarray(start, consumed).toString('utf8');
      }
      return {
        ...base,
        state: 'read',
        source,
        text: sanitize(text),
        nextOffset: consumed < metadata.size ? consumed : null,
      };
    } finally {
      await file.close();
    }
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    return {
      ...base,
      state: missing ? 'absent' : 'error',
      error: missing
        ? 'Worklog not present'
        : error instanceof Error &&
            error.message === 'Worklog context exceeds safe 1 MiB read bound'
          ? 'Worklog context exceeds safe 1 MiB read bound; inspect later records locally in a terminal'
          : 'Cannot read validated log source; check registration and file permissions',
    };
  }
}
