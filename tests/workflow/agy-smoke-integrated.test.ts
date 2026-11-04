import { test, expect } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  rmSync,
  realpathSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgyRunner } from '../../packages/core/src/workflow/runtime/agy-runner.js';
import {
  startRun,
  recoverRun,
  dispatchStage,
  collectBusinessTurn,
  inspectRuns,
  stopRun,
  releaseRun,
  updateRunRegistry,
} from '../../packages/core/src/workflow/run/run-driver.js';
import { reconcileStartup } from '../../packages/core/src/workflow/run/startup.js';

function isTmuxAvailable(): boolean {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('Agy/tmux integrated smoke workflow scenario', async () => {
  if (!isTmuxAvailable()) {
    console.warn('tmux CLI is not available in environment; skipping real tmux smoke test');
    return;
  }

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-agy-smoke-')));
  const pool = join(root, 'pool');
  const project = join(root, 'repo');
  const bin = join(root, 'bin');

  mkdirSync(pool, { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(bin, { recursive: true });

  // Initialize git repository in project
  execFileSync('git', ['init', '-b', 'main'], { cwd: project, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Smoke Tester'], { cwd: project, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'smoke@example.com'], { cwd: project, stdio: 'ignore' });
  writeFileSync(join(project, 'README.md'), '# Smoke Test Project\n');
  execFileSync('git', ['add', 'README.md'], { cwd: project, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: project, stdio: 'ignore' });

  const configFile = join(project, '.epic-config.json');
  writeFileSync(
    configFile,
    JSON.stringify({
      clone_root: 'pool',
      clone_names: [],
      local_worktrees: true,
    }),
  );

  const config = {
    file: configFile,
    project,
    root: pool,
    slots: [],
    worktrees: true,
    base: 'main',
  };

  // Create mock agy CLI inside bin/agy
  const mockAgyPath = join(bin, 'agy');
  writeFileSync(
    mockAgyPath,
    `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  process.stdout.write('Usage of agy:\\n--prompt-interactive\\n--conversation\\n--settings\\n--add-dir\\n');
  process.exit(0);
}

// Find --settings
const settingsIdx = args.indexOf('--settings');
const settingsPath = settingsIdx !== -1 ? args[settingsIdx + 1] : undefined;
if (!settingsPath || !fs.existsSync(settingsPath)) {
  process.exit(1);
}
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
const hookCmd = settings.statusLine?.command;
const attemptDir = path.dirname(settingsPath);

// Find prompt
const promptIdx = args.indexOf('--prompt-interactive');
const initialPrompt = promptIdx !== -1
  ? args[promptIdx + 1]
  : (fs.existsSync(path.join(attemptDir, 'agy-input.txt')) ? fs.readFileSync(path.join(attemptDir, 'agy-input.txt'), 'utf8') : '');

// Parse attempt identity: "Run <runId>, role <role>, Attempt <attemptId>."
const match = initialPrompt.match(/Run ([^,]+), role ([^,]+), Attempt ([^\\.]+)\\./);
const runId = match ? match[1] : 'unknown';
const role = match ? match[2] : 'unknown';
const attemptId = match ? match[3] : 'unknown';

// Conversation
const convIdx = args.indexOf('--conversation');
const conversation_id = convIdx !== -1 ? args[convIdx + 1] : 'conv-' + crypto.randomUUID();

const transcriptPath = path.join(attemptDir, 'transcript.jsonl');
let stepIndex = 0;
const steps = [
  {
    step_index: stepIndex++,
    type: 'USER_INPUT',
    source: 'USER_EXPLICIT',
    status: 'DONE',
    content: '<USER_REQUEST>\\n' + initialPrompt + '\\n</USER_REQUEST>',
  },
  {
    step_index: stepIndex++,
    type: 'PLANNER_RESPONSE',
    source: 'MODEL',
    status: 'DONE',
    content: '[pc ready role=' + role + ' attempt=' + attemptId + ']\\nRole initialized and ready.',
  },
];
fs.writeFileSync(transcriptPath, steps.map(s => JSON.stringify(s)).join('\\n') + '\\n');

// Parse startup.md to perform role initialization
const startupPath = path.join(attemptDir, 'startup.md');
if (fs.existsSync(startupPath)) {
  const startupContent = fs.readFileSync(startupPath, 'utf8');
  const jsonMatch = startupContent.match(/\`\`\`json\\n([\\s\\S]*?)\\n\`\`\`/);
  if (jsonMatch) {
    try {
      const initPayload = JSON.parse(jsonMatch[1]);
      fs.writeFileSync(path.join(attemptDir, 'initialization.json'), JSON.stringify(initPayload));
      if (role === 'worker') {
        const checkout = process.cwd();
        fs.writeFileSync(
          path.join(checkout, '.epic-status.json'),
          JSON.stringify({
            issue: Number(initPayload.subject?.split('#').at(-1) || 1),
            phase: 'exploring',
            summary: 'Worker in progress',
            updated_at: new Date().toISOString(),
          }),
        );
        fs.appendFileSync(
          path.join(checkout, '.epic-worklog.md'),
          '\\n' + new Date().toISOString() + ' startup ' + attemptId + '\\n',
        );
      }
    } catch {}
  }
}

// Fire hook
if (hookCmd) {
  try {
    execSync(hookCmd, {
      input: JSON.stringify({
        conversation_id,
        transcript_path: transcriptPath,
        agent_state: 'idle',
      }),
      stdio: ['pipe', 'ignore', 'ignore'],
    });
  } catch {}
}

// Watch for incoming activation or business messages
const seen = new Set();
const interval = setInterval(() => {
  try {
    const files = fs.readdirSync(attemptDir);
    for (const file of files) {
      if (file.startsWith('message-') && file.endsWith('.json') && !seen.has(file)) {
        seen.add(file);
        const msg = JSON.parse(fs.readFileSync(path.join(attemptDir, file), 'utf8'));
        const brief = msg.brief;
        const raw = fs.readFileSync(transcriptPath, 'utf8').trim();
        const currentSteps = raw ? raw.split('\\n').map(l => JSON.parse(l)) : [];
        currentSteps.push({
          step_index: currentSteps.length,
          type: 'USER_INPUT',
          source: 'USER_EXPLICIT',
          status: 'DONE',
          content: '<USER_REQUEST>\\n' + brief + '\\n</USER_REQUEST>',
        });
        if (role === 'worker') {
          currentSteps.push({
            step_index: currentSteps.length,
            type: 'PLANNER_RESPONSE',
            source: 'MODEL',
            status: 'DONE',
            content: 'WORKER_SMOKE_RESULT_COMPLETED',
          });
        }
        fs.writeFileSync(transcriptPath, currentSteps.map(s => JSON.stringify(s)).join('\\n') + '\\n');
        if (hookCmd) {
          execSync(hookCmd, {
            input: JSON.stringify({
              conversation_id,
              transcript_path: transcriptPath,
              agent_state: 'idle',
            }),
            stdio: ['pipe', 'ignore', 'ignore'],
          });
        }
      }
    }
  } catch {}
}, 50);

process.on('SIGTERM', () => {
  clearInterval(interval);
  process.exit(0);
});
process.on('SIGHUP', () => {
  clearInterval(interval);
  process.exit(0);
});
`,
    { mode: 0o755 },
  );

  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;

  const runner = new AgyRunner();
  let runId: string | undefined;

  try {
    // 1. Preflight check
    await runner.preflight();

    // 2. Start and initialize Orchestrator
    const subject = {
      repository: 'smoke/repo',
      number: 42,
      kind: 'issue' as const,
      title: 'Smoke Test Issue',
      body: 'Smoke test orchestrator instructions',
    };
    const run = await startRun(config, runner, subject, 'agy');
    runId = run.id;

    expect(run.lifecycle).toBe('running');
    expect(run.provider).toBe('agy');
    expect(run.orchestrator).toBeDefined();

    const orchestratorAttempt = run.orchestrator!;
    expect(orchestratorAttempt.address).toMatch(/^tmux:%[0-9]+$/);
    expect(orchestratorAttempt.terminalSession).toBe(`pc-run-${run.id}`);

    // Verify real tmux session was created
    const tmuxSessions = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf8',
    });
    expect(tmuxSessions).toContain(`pc-run-${run.id}`);

    // 3. Activate Orchestrator
    await reconcileStartup(config, runner, run.id);

    const activatedRun = inspectRuns(config).runs.find((r) => r.id === run.id)!;
    expect(activatedRun.orchestrator?.activation?.status).toBe('delivered');

    // 4. Observe execution state of Orchestrator
    const obsOrch = await runner.observe(activatedRun.orchestrator!);
    expect(obsOrch.status).toBe('idle');
    expect(obsOrch.evidence).toContain('Native agy status callback');

    // 5. Dispatch a small Worker stage task
    const dispatch = await dispatchStage(config, runner, {
      runId: run.id,
      authority: activatedRun.orchestrator!.id,
      subject: 'smoke/repo#42',
      role: 'worker',
      stage: 'implementation',
      inputRevision: '1',
      brief: 'Implement small worker smoke task',
      prerequisites: [],
      checkout: project,
    });

    expect(dispatch.lifecycle).toBe('running');
    expect(dispatch.attempts).toHaveLength(1);

    const workerAttempt = dispatch.attempts[0];
    expect(workerAttempt.address).toMatch(/^tmux:%[0-9]+$/);
    expect(workerAttempt.providerState?.paneId).toBeDefined();

    // Activate Worker
    await reconcileStartup(config, runner, run.id);
    const workerActivated = inspectRuns(config)
      .dispatches?.find((d) => d.id === dispatch.id)
      ?.attempts[0]!;
    expect(workerActivated.activation?.status).toBe('delivered');

    // 6. Collect and accept Worker Receipt
    const workerResult = await collectBusinessTurn(
      config,
      runner,
      workerActivated,
      (val) => expect(val).toBe('WORKER_SMOKE_RESULT_COMPLETED'),
      { timeoutMs: 5000 },
    );
    expect(workerResult).toBe('WORKER_SMOKE_RESULT_COMPLETED');

    const acceptedDispatch = inspectRuns(config).dispatches?.find((d) => d.id === dispatch.id)!;
    expect(acceptedDispatch.lifecycle).toBe('accepted');
    expect(acceptedDispatch.acceptedReceipt).toBeDefined();

    // 7. Exercise live cancellation on a second dispatch attempt
    const dispatch2 = await dispatchStage(config, runner, {
      runId: run.id,
      authority: activatedRun.orchestrator!.id,
      subject: 'smoke/repo#42',
      role: 'worker',
      stage: 'verification',
      inputRevision: '1',
      brief: 'Second task for live cancellation',
      prerequisites: [dispatch.id],
      checkout: project,
    });

    const liveAttempt = dispatch2.attempts[0];
    expect(await runner.stopped(liveAttempt)).toBe(false);

    // Cancel while live
    const cancelResult = await runner.cancel(liveAttempt);
    expect(cancelResult.evidence).toContain('Owned Agy pane terminated and absence verified');
    expect(await runner.stopped(liveAttempt)).toBe(true);

    // 8. Recover without relaunch
    const recoveryResult = await recoverRun(config, runner, run.id);
    expect(recoveryResult.blockers).toEqual([]);

    const runAfterRecovery = inspectRuns(config).runs.find((r) => r.id === run.id)!;
    expect(runAfterRecovery.orchestratorId).toBe(activatedRun.orchestrator!.id);
    expect(runAfterRecovery.orchestrator?.id).toBe(activatedRun.orchestrator!.id);
    expect(runAfterRecovery.orchestrator?.address).toBe(activatedRun.orchestrator!.address);

    // 9. Stop and release
    const stopResult = await stopRun(config, runner, run.id);
    expect(stopResult.lifecycle).toBe('blocked');
    expect(stopResult.attempts.length).toBeGreaterThan(0);

    // Verify Orchestrator attempt stopped
    expect(await runner.stopped(activatedRun.orchestrator!)).toBe(true);

    // Mark completed to verify releaseRun
    updateRunRegistry(config, (reg) => {
      reg.runs.find((r) => r.id === run.id)!.lifecycle = 'completed';
    });

    const releaseResult = await releaseRun(config, runner, run.id, { cleanup: () => {} });
    expect(releaseResult.lifecycle).toBe('completed');
    expect(releaseResult.blockers).toEqual([]);
  } finally {
    process.env.PATH = originalPath;
    if (runId) {
      try {
        execFileSync('tmux', ['kill-session', '-t', `pc-run-${runId}`], { stdio: 'ignore' });
      } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 45000);
