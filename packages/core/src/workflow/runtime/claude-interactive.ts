import { refreshStartupAttempt, roleInitializationReady } from '../run/role-initialization.js';
/** Claude native hooks correlate persistent TUI turns with durable dispatches. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { quote, type ManagedAttempt, type ExecutionObservation } from './runtime.js';
import { StreamRunner } from './codex-interactive.js';
const delay = () => new Promise((resolve) => setTimeout(resolve, 100));
type Hook = {
  transcript_path?: string;
  session_id: string;
  hook_event_name: string;
  prompt_id?: string;
  prompt?: string;
  last_assistant_message?: string;
};
/** Only native hook payloads from this attempt directory are execution evidence. */
export class ClaudeInteractive {
  private events(a: ManagedAttempt): Hook[] {
    const dir = join(a.directory, 'claude-hooks');
    return existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith('.json'))
          .sort((a, b) => statSync(join(dir, a)).mtimeMs - statSync(join(dir, b)).mtimeMs)
          .flatMap((f) => {
            try {
              return [JSON.parse(readFileSync(join(dir, f), 'utf8')) as Hook];
            } catch {
              return [];
            }
          })
          .filter((e) => e.session_id === a.conversation)
      : [];
  }
  private address(a: ManagedAttempt): string {
    if (!a.address?.startsWith('tmux:')) throw new Error('Claude lacks persisted tmux identity');
    return a.address.slice(5);
  }
  async preflight(): Promise<void> {
    execFileSync('tmux', ['-V'], { timeout: 5000 });
    const help = execFileSync('claude', ['--help'], { encoding: 'utf8', timeout: 5000 });
    for (const flag of [
      '--session-id',
      '--resume',
      '--settings',
      '--append-system-prompt',
      '--add-dir',
      '--strict-mcp-config',
    ])
      if (!help.includes(flag)) throw new Error(`Claude lacks required capability ${flag}`);
    let auth: { loggedIn?: boolean };
    try {
      auth = JSON.parse(
        execFileSync('claude', ['auth', 'status'], { encoding: 'utf8', timeout: 5000 }),
      );
    } catch (error) {
      throw new Error(
        `Claude authentication check failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (!auth.loggedIn) throw new Error('Claude authentication required: run claude auth login');
  }
  private panes(): Map<string, string> {
    try {
      return new Map(
        execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{pane_dead}'], {
          encoding: 'utf8',
        })
          .trim()
          .split('\n')
          .map((line) => line.split(' ') as [string, string]),
      );
    } catch {
      throw new Error('Cannot verify tmux occupancy');
    }
  }
  async stopped(a: ManagedAttempt): Promise<boolean> {
    if (!a.address?.startsWith('tmux:')) return true;
    const panes = this.panes();
    return (
      panes.get(this.address(a)) === '1' ||
      (!panes.has(this.address(a)) &&
        (existsSync(join(a.directory, 'claude-terminated')) ||
          existsSync(join(a.directory, 'exit-code'))))
    );
  }
  async cancel(a: ManagedAttempt): Promise<{ evidence: string }> {
    execFileSync('tmux', ['kill-pane', '-t', this.address(a)]);
    if (this.panes().has(this.address(a))) throw new Error('Claude pane termination unverified');
    writeFileSync(join(a.directory, 'claude-terminated'), this.address(a));
    return { evidence: 'Owned Claude pane terminated and absence verified' };
  }
  async terminated(a: ManagedAttempt): Promise<boolean> {
    return this.stopped(a);
  }
  async start(a: ManagedAttempt) {
    mkdirSync(join(a.directory, 'claude-hooks'), { recursive: true });
    const resume = !!a.conversation;
    if (resume && !a.predecessor)
      throw new Error(
        'Claude resume requires a linked replacement attempt and a reconciliation brief',
      );
    a.conversation ??= randomUUID();
    const hook = join(a.directory, 'claude-hook.cjs');
    writeFileSync(
      hook,
      `const fs=require('node:fs'),crypto=require('node:crypto');let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const d=JSON.parse(s);fs.writeFileSync(${JSON.stringify(join(a.directory, 'claude-hooks'))}+'/'+crypto.randomUUID()+'.json',JSON.stringify(d),{mode:384});});`,
    );
    const settings = join(a.directory, 'claude-settings.json');
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: Object.fromEntries(
          [
            'SessionStart',
            'UserPromptSubmit',
            'Stop',
            'SessionEnd',
            'Notification',
            'PermissionRequest',
          ].map((event) => [
            event,
            [{ hooks: [{ type: 'command', command: `node ${quote(hook)}` }] }],
          ]),
        ),
      }),
    );
    const args = [
      'claude',
      resume ? '--resume' : '--session-id',
      a.conversation,
      '--settings',
      settings,
      '--strict-mcp-config',
      '--append-system-prompt',
      `Initialize role ${a.role} using applicable project/role instructions and durable state. Once initialization is complete, emit a separate assistant text line exactly [pc ready role=${a.role} attempt=${a.id}] ${a.startupGate ? 'then end this turn immediately and await a separate activation message. Do not poll for activation in this turn.' : 'before continuing the task.'} Never emit this acknowledgement if initialization is blocked. This is execution readiness, not task acceptance.`,
      ...[
        a.directory,
        ...(a.predecessor ? [dirname(a.directory)] : []),
        ...(a.writableDirectories ?? []),
      ].flatMap((path) => ['--add-dir', path]),
      '--',
      a.brief,
    ];
    const script = join(a.directory, 'claude-launch.sh');
    writeFileSync(
      script,
      `#!/bin/sh\n${args.map(quote).join(' ')}\nprintf '%s' "$?" > ${quote(join(a.directory, 'exit-code'))}\n`,
      { mode: 0o700 },
    );
    const session = `pc-claude-${a.id}`;
    const tmuxArgs = a.terminalSession
      ? ['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', a.terminalSession, '-n', session]
      : ['new-session', '-d', '-P', '-F', '#{pane_id}', '-s', session];
    a.address =
      'tmux:' +
      execFileSync('tmux', [...tmuxArgs, '-c', a.checkout, script], { encoding: 'utf8' }).trim();
    writeFileSync(
      join(a.directory, 'terminal.json'),
      JSON.stringify({ address: a.address, conversation: a.conversation }),
    );
    execFileSync('tmux', ['set-option', '-p', '-t', this.address(a), 'remain-on-exit', 'on']);
    let incompleteStopAt: number | undefined;
    for (let n = 0; n < 600; n++) {
      const receipt = await this.recoverReceipt(a);
      if (receipt && roleInitializationReady(a)) return receipt;
      const events = this.events(a);
      const submitted = events.find(
        (e) => e.hook_event_name === 'UserPromptSubmit' && e.prompt === a.brief,
      );
      if (
        submitted?.prompt_id &&
        events.some((e) => e.hook_event_name === 'Stop' && e.prompt_id === submitted.prompt_id)
      ) {
        incompleteStopAt ??= Date.now();
        if (Date.now() - incompleteStopAt > 2000)
          throw new Error(
            `Claude startup turn completed without required native acknowledgement and durable ${a.role} initialization; inspect ${a.directory} and ${a.address}`,
          );
      }
      await delay();
    }
    const pane = execFileSync('tmux', ['capture-pane', '-p', '-t', this.address(a)], {
      encoding: 'utf8',
    });
    throw new Error(
      `Claude startup unacknowledged; inspect trust/auth/configuration or waiting prompt at ${a.address}: ${pane.slice(-2000)}`,
    );
  }
  async recoverReceipt(a: ManagedAttempt) {
    if (!a.conversation && existsSync(join(a.directory, 'terminal.json')))
      Object.assign(a, JSON.parse(readFileSync(join(a.directory, 'terminal.json'), 'utf8')));
    if (!a.address?.startsWith('tmux:') || !a.conversation) return undefined;
    // Historic hooks never authorize a missing or dead execution.
    if (this.panes().get(this.address(a)) !== '0') return undefined;
    const events = this.events(a);
    if (!events.some((e) => e.hook_event_name === 'SessionStart')) return undefined;
    const submissions = events.filter(
      (e) => e.hook_event_name === 'UserPromptSubmit' && e.prompt === a.brief && !!e.prompt_id,
    );
    if (submissions.length !== 1) return undefined;
    if (!this.ready(a, events, submissions[0].prompt_id!)) return undefined;
    if (
      a.startupGate &&
      !events.some((e) => e.hook_event_name === 'Stop' && e.prompt_id === submissions[0].prompt_id)
    )
      return undefined;
    return {
      conversation: a.conversation!,
      address: a.address!,
      evidence:
        'Live native Claude session, exact brief submission and correlated assistant acknowledgement',
    };
  }
  private ready(a: ManagedAttempt, hooks: Hook[], prompt: string): boolean {
    const path = hooks.find((e) => e.hook_event_name === 'SessionStart')?.transcript_path;
    if (!path || !existsSync(path)) return false;
    type Native = {
      uuid: string;
      parentUuid?: string;
      sessionId?: string;
      type?: string;
      promptId?: string;
      message?: { content?: string | { type: string; text?: string }[] };
    };
    const records: Native[] = readFileSync(path, 'utf8')
      .split('\n')
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Native];
        } catch {
          return [];
        }
      })
      .filter((e) => e.sessionId === a.conversation);
    const index = new Map(records.map((e) => [e.uuid, e]));
    const marker = `[pc ready role=${a.role} attempt=${a.id}]`;
    for (const record of records) {
      if (
        record.type !== 'assistant' ||
        !Array.isArray(record.message?.content) ||
        !record.message.content.some(
          (c) => c.type === 'text' && c.text?.split('\n').some((line) => line.trim() === marker),
        )
      )
        continue;
      let parent = record.parentUuid;
      const seen = new Set<string>();
      while (parent && !seen.has(parent)) {
        seen.add(parent);
        const previous = index.get(parent);
        if (!previous) break;
        if (previous.type === 'user' && previous.promptId) {
          if (previous.promptId === prompt) return true;
          break;
        }
        parent = previous.parentUuid;
      }
    }
    return false;
  }
  async result(a: ManagedAttempt, id: string): Promise<string | undefined> {
    refreshStartupAttempt(a);
    if (id !== (a.dispatchId ?? a.id) || (a.startupGate && !a.activation)) return undefined;
    const events = this.events(a);
    const submissions = events.filter(
      (e) =>
        e.hook_event_name === 'UserPromptSubmit' &&
        e.prompt === (a.startupGate ? a.activation?.brief : a.brief),
    );
    if (submissions.length !== 1 || !submissions[0].prompt_id) return undefined;
    const results = events.filter(
      (e) => e.hook_event_name === 'Stop' && e.prompt_id === submissions[0].prompt_id,
    );
    const marker = `[pc ready role=${a.role} attempt=${a.id}]`;
    return results.length === 1
      ? results[0].last_assistant_message
          ?.split('\n')
          .filter((line) => line.trim() !== marker)
          .join('\n')
          .trim() || undefined
      : undefined;
  }
  async messageReceipt(a: ManagedAttempt, message: { id: string; brief: string }) {
    return this.events(a).some(
      (e) =>
        e.hook_event_name === 'UserPromptSubmit' && !!e.prompt_id && e.prompt === message.brief,
    )
      ? 'Native exact Claude activation input'
      : undefined;
  }
  async send(a: ManagedAttempt, message: { id: string; brief: string }) {
    if (!a.address?.startsWith('tmux:'))
      return { status: 'uncertain' as const, evidence: 'Claude lacks persisted tmux identity' };
    const prior = new Set(
      this.events(a)
        .map((e) => e.prompt_id)
        .filter(Boolean),
    );
    const file = join(a.directory, `message-${randomUUID()}.txt`);
    writeFileSync(file, message.brief);
    const buffer = `pc-${randomUUID()}`;
    try {
      execFileSync('tmux', ['load-buffer', '-b', buffer, file]);
      execFileSync('tmux', ['paste-buffer', '-p', '-d', '-b', buffer, '-t', this.address(a)]);
      execFileSync('tmux', ['send-keys', '-t', this.address(a), 'Enter']);
      for (let n = 0; n < 50; n++) {
        if (
          this.events(a).some(
            (e) =>
              e.hook_event_name === 'UserPromptSubmit' &&
              !!e.prompt_id &&
              !prior.has(e.prompt_id) &&
              e.prompt === message.brief,
          )
        )
          return { status: 'delivered' as const, evidence: 'Native exact UserPromptSubmit' };
        await delay();
      }
      return {
        status: 'uncertain' as const,
        evidence:
          'Input sent without exact native submission acknowledgement; reconcile before retry',
      };
    } catch (error) {
      return { status: 'uncertain' as const, evidence: String(error) };
    }
  }
  async observe(a: ManagedAttempt): Promise<ExecutionObservation> {
    const events = this.events(a);
    const last = events.at(-1);
    let status: ExecutionObservation['status'] = 'unknown';
    try {
      if (await this.terminated(a)) status = 'exited';
      else if (last?.hook_event_name === 'Stop') status = 'idle';
      else if (
        last?.hook_event_name === 'PermissionRequest' ||
        last?.hook_event_name === 'Notification'
      )
        status = 'waiting';
      else if (
        last?.hook_event_name === 'UserPromptSubmit' ||
        last?.hook_event_name === 'SessionStart'
      )
        status = 'running';
    } catch {
      /* Unavailable tmux evidence remains unknown. */
    }
    return {
      status,
      at: new Date().toISOString(),
      evidence: 'Native Claude hooks; turn completion is not acceptance',
    };
  }
}

/**
 * Temporary legacy internal contract retained for migration slices (#146-#150).
 * Removed in ticket #150.
 */
export class ClaudeRunner extends StreamRunner {
  readonly name = 'claude';
  readonly automaticStartup = true;
  readonly cancellation = true;
  readonly interactive: boolean = true;
  protected resumeFlag = '--resume';
  private readonly tui = new ClaudeInteractive();
  preflight() {
    return this.tui.preflight();
  }
  start(a: ManagedAttempt) {
    return this.tui.start(a);
  }
  recoverReceipt(a: ManagedAttempt) {
    return this.tui.recoverReceipt(a);
  }
  messageReceipt(a: ManagedAttempt, m: { id: string; brief: string }) {
    return this.tui.messageReceipt(a, m);
  }
  stopped(a: ManagedAttempt) {
    return this.tui.terminated(a);
  }
  termination(a: ManagedAttempt) {
    return this.tui.terminated(a);
  }
  cancel(a: ManagedAttempt) {
    return this.tui.cancel(a);
  }
  send(a: ManagedAttempt, m: { id: string; brief: string }) {
    return this.tui.send(a, m);
  }
  result(a: ManagedAttempt, id: string) {
    return this.tui.result(a, id);
  }
  observe(a: ManagedAttempt) {
    return this.tui.observe(a);
  }
  /** Persistent completion uses correlated native turn output, never process exit. */
  async collect(a: ManagedAttempt): Promise<string> {
    for (;;) {
      const output = await this.tui.result(a, a.dispatchId ?? a.id);
      if (output !== undefined) return output;
      if (await this.stopped(a)) throw new Error('Claude exited without a correlated task result');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  collectable(a: ManagedAttempt): boolean {
    return existsSync(join(a.directory, 'claude-hooks'));
  }
}

