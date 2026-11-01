/** Claude native hooks correlate persistent TUI turns with durable dispatches. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ManagedAttempt, ExecutionObservation } from './runtime.js';
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const delay = () => new Promise((resolve) => setTimeout(resolve, 100));
type Hook = {
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
    for (const flag of ['--session-id', '--resume', '--settings'])
      if (!help.includes(flag)) throw new Error(`Claude lacks required capability ${flag}`);
    const auth = JSON.parse(
      execFileSync('claude', ['auth', 'status'], { encoding: 'utf8', timeout: 5000 }),
    );
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
      ...(!resume ? [a.brief] : []),
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
    for (let n = 0; n < 150; n++) {
      const receipt = await this.recoverReceipt(a);
      if (receipt) return receipt;
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
    const events = this.events(a);
    if (!events.some((e) => e.hook_event_name === 'SessionStart')) return undefined;
    if (
      !a.predecessor &&
      !events.some((e) => e.hook_event_name === 'UserPromptSubmit' && e.prompt === a.brief)
    )
      return undefined;
    return {
      conversation: a.conversation!,
      address: a.address!,
      evidence: 'Native Claude SessionStart and exact initial submission (or exact resume)',
    };
  }
  async result(a: ManagedAttempt, id: string): Promise<string | undefined> {
    if (id !== a.dispatchId) return undefined;
    const events = this.events(a);
    const submissions = events.filter(
      (e) => e.hook_event_name === 'UserPromptSubmit' && e.prompt === a.brief,
    );
    if (submissions.length !== 1 || !submissions[0].prompt_id) return undefined;
    const results = events.filter(
      (e) => e.hook_event_name === 'Stop' && e.prompt_id === submissions[0].prompt_id,
    );
    return results.length === 1 ? results[0].last_assistant_message : undefined;
  }
  async send(a: ManagedAttempt, message: { id: string; brief: string }) {
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
