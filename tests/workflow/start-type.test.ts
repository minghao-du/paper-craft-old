import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, expect, it, vi } from 'vitest';
import { registerWorkflowCommands } from '../../packages/cli/src/commands/workflow.js';
import { startRun } from '@paper-craft/core/workflow/startup';
import { readIssue } from '@paper-craft/core/workflow/run-subject';

vi.mock('@paper-craft/core/workflow/startup', async (original) => ({
  ...(await original<typeof import('@paper-craft/core/workflow/startup')>()),
  startRun: vi.fn(async () => ({
    id: 'run-id',
    lifecycle: 'running',
    brief: { path: '/context', hash: 'hash' },
  })),
}));
vi.mock('@paper-craft/core/workflow/run-subject', async (original) => ({
  ...(await original<typeof import('@paper-craft/core/workflow/run-subject')>()),
  readIssue: vi.fn(),
}));
vi.mock('@paper-craft/core/workflow/fleet-config', () => ({
  loadFleetConfig: () => ({ project: '/project', file: '/project/.epic-config.json' }),
}));
vi.mock('../../packages/cli/src/workflow/composition.js', () => ({
  createRunner: vi.fn((provider: string) => {
    if (provider !== 'agy')
      throw new Error(`Unsupported managed provider '${provider}'. Only 'agy' is supported.`);
    return { name: 'agy', preflight: async () => {} };
  }),
  launchStartupSupervisor: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  process.exitCode = 0;
});

it('starts empty EPICs by title and rejects conflicting explicit types before launch', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const [title, kind] of [
    ['[EPIC] Plan work', 'epic'],
    ['Plan an epic: next steps', 'epic'],
    ['Fix epicenter detection', 'issue'],
    ['Ordinary delivery', 'issue'],
  ] as const) {
    vi.mocked(readIssue).mockReturnValue({ repository: 'org/repo', number: 7, title, body: '' });
    for (const type of ['issue', 'epic']) {
      vi.mocked(startRun).mockClear();
      process.exitCode = 0;
      const program = new Command();
      registerWorkflowCommands(program, { human: () => false });
      await program.parseAsync(
        ['workflow', 'orchestrator', 'start', '7', '--provider', 'agy', '--type', type],
        { from: 'user' },
      );
      if (type === kind) {
        expect(startRun).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          { repository: 'org/repo', number: 7, title, body: '', kind },
          'agy',
          undefined,
          undefined,
        );
        expect(process.exitCode).toBe(0);
      } else {
        expect(startRun).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(2);
        expect(log.mock.lastCall?.[0]).toContain('Type mismatch');
      }
    }
  }
});

it('requires a valid explicit type before reading GitHub or launching a Run', async () => {
  for (const args of [[], ['--type', 'other']]) {
    const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
    registerWorkflowCommands(program, { human: () => false });
    await expect(
      program.parseAsync(['workflow', 'orchestrator', 'start', '7', '--provider', 'agy', ...args], {
        from: 'user',
      }),
    ).rejects.toThrow();
    expect(readIssue).not.toHaveBeenCalled();
    expect(startRun).not.toHaveBeenCalled();
  }
});

it('captures multiline Requirements and rejects invalid input before tracker or Run mutation', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const directory = mkdtempSync(join(tmpdir(), 'pc-requirements-'));
  const file = join(directory, 'requirements.md');
  const requirements = 'Preserve raw data\nUse TypeScript only\n';
  writeFileSync(file, requirements);
  vi.mocked(readIssue).mockReturnValue({
    repository: 'org/repo',
    number: 7,
    title: 'Task',
    body: '',
  });
  const invoke = async (args: string[]) => {
    const program = new Command();
    registerWorkflowCommands(program, { human: () => false });
    await program.parseAsync(
      ['workflow', 'orchestrator', 'start', '7', '--provider', 'agy', '--type', 'issue', ...args],
      { from: 'user' },
    );
  };
  try {
    await invoke(['--requirements-file', file]);
    expect(vi.mocked(startRun).mock.lastCall?.[4]).toBe(requirements);
    for (const args of [
      ['--requirements', 'inline', '--requirements-file', file],
      ['--requirements-file', join(directory, 'missing')],
    ]) {
      vi.mocked(startRun).mockClear();
      vi.mocked(readIssue).mockClear();
      await invoke(args);
      expect(startRun).not.toHaveBeenCalled();
      expect(readIssue).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('forwards explicit agy permission opt-in and rejects it for other providers before intake', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.mocked(readIssue).mockReturnValue({
    repository: 'org/repo',
    number: 7,
    title: 'Task',
    body: '',
  });
  for (const provider of ['agy', 'codex', 'claude']) {
    vi.mocked(startRun).mockClear();
    vi.mocked(readIssue).mockClear();
    process.exitCode = 0;
    const program = new Command();
    registerWorkflowCommands(program, { human: () => false });
    await program.parseAsync(
      [
        'workflow',
        'orchestrator',
        'start',
        '7',
        '--provider',
        provider,
        '--type',
        'issue',
        '--dangerously-skip-permissions',
      ],
      { from: 'user' },
    );
    if (provider === 'agy') {
      expect(vi.mocked(startRun).mock.lastCall?.[5]).toBe(true);
      expect(process.exitCode).toBe(0);
    } else {
      expect(startRun).not.toHaveBeenCalled();
      expect(readIssue).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
    }
  }
});
