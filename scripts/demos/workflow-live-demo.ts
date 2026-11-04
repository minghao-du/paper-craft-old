/** Opt-in native scheduling over the same isolated CLI and scripted subordinate tasks. */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRunner } from '../../packages/cli/src/workflow/composition.js';
import { inspectRuns } from '../../packages/core/src/workflow/run/run-registry.js';
import { reconcileStartup } from '../../packages/core/src/workflow/run/startup.js';
import {
  prepareScriptedEpic,
  prepareDeliveryTasks,
  prepareFinalizationTasks,
  verifyAllRoleOutcome,
} from '../../tests/workflow/scripted-epic-demo.js';

if (process.argv.includes('--help')) {
  console.log(
    'Usage: pnpm exec tsx scripts/demos/workflow-live-demo.ts agy\nExplicit opt-in native scheduler; controlled subordinate scripts; retained toy evidence. PC_LIVE_DEMO_TIMEOUT_MS bounds observation.',
  );
  process.exit(0);
}
const provider = process.argv[2];
if (provider !== 'agy')
  throw new Error(
    'Explicit provider required: pnpm exec tsx scripts/demos/workflow-live-demo.ts agy',
  );
const native = createRunner(provider);
let demo: Awaited<ReturnType<typeof prepareScriptedEpic>> | undefined;
let busy = false;
const requests: unknown[] = [];
const server = createServer(async (req, res) => {
  if (!demo || busy || req.method !== 'POST') {
    res.writeHead(409).end('Not ready');
    return;
  }
  busy = true;
  const savedExit = process.exitCode;
  const logs: unknown[] = [];
  const originalLog = console.log;
  try {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 65536) throw new Error('Request too large');
    }
    const input = JSON.parse(body) as { operation: string; args?: string[] };
    const record = {
      actor: req.headers['x-demo-actor'] === 'observer' ? 'observer' : 'scheduler',
      request: input,
    };
    requests.push(input);
    appendFileSync(
      join(demo.directory, 'native-cli-requests.jsonl'),
      JSON.stringify(record) + '\n',
    );
    console.log = (...values) => logs.push(...values);
    process.exitCode = undefined;
    if (input.operation === 'integrate') demo.git('merge', '--ff-only', 'toy-worker');
    else if (input.operation === 'confirmation') {
      const registry = inspectRuns(demo.config);
      const head = demo.git('rev-parse', 'HEAD');
      const deliveries = registry.deliveries!.filter((d) => d.runId === demo!.run.id);
      const path = join(demo.directory, 'human-closure.json');
      writeFileSync(
        path,
        JSON.stringify({
          deliveryVersion: createHash('sha256')
            .update(JSON.stringify({ head, deliveries }))
            .digest('hex'),
          source: 'human',
          evidence: 'Controlled fixture input only, not production human judgment',
        }),
      );
      logs.push({ path });
    } else if (input.operation === 'status') logs.push(inspectRuns(demo.config));
    else if (input.operation === 'terminate') {
      const dispatch = inspectRuns(demo.config).dispatches!.find((d) => d.id === input.args?.[0]);
      if (!dispatch) throw new Error('Unknown dispatch');
      await demo.runner.cancel(dispatch.attempts.at(-1)!);
    } else {
      await demo.cli(input.operation, input.args);
      await reconcileStartup(demo.config, demo.runner, demo.run.id);
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ exitCode: process.exitCode ?? 0, output: logs }));
  } catch (error) {
    res.writeHead(400).end(JSON.stringify({ error: String(error) }));
  } finally {
    process.exitCode = savedExit;
    console.log = originalLog;
    busy = false;
  }
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Missing local demo address');
const endpoint = `http://127.0.0.1:${address.port}`;
const brief = `Isolated toy EPIC demo. You are the sole scheduler. All subordinates are tiny scripts, not native model agents. Choose assignments and CLI requests yourself. No network except the loopback demo endpoint, no real GitHub/research operations.
Use curl -s -X POST ${endpoint} -H 'Content-Type: application/json' -d '{"operation":"status"}'. Other operations use JSON {operation,args:string[]} and invoke the public stage CLI. For command help read ${resolve('skills/pc-orchestrator/managed-lifecycle.md')}. Request setup will be in DEMO-TASKS.md in your checkout after activation. Read it, then autonomously finish all seven roles. Do not ask human questions; fixture closure/coordinator judgments are supplied. End with evidence references or actionable blocker.`;
let outcome = 'blocked';
try {
  demo = await prepareScriptedEpic(native, brief);
  const checkout = prepareDeliveryTasks(demo);
  // Fixed tasks produce artifacts only. The native Orchestrator chooses every dispatch and disposition.
  prepareFinalizationTasks(demo);
  const decision = join(demo.directory, 'review.md');
  writeFileSync(
    decision,
    'Toy coordinator supplied judgment: bounded infrastructure delivery only; independently inspect artifacts and current revision before acceptance.',
  );
  const coordinator = join(demo.directory, 'coordinator.json');
  writeFileSync(
    coordinator,
    JSON.stringify({
      identity: 'Toy coordinator',
      entry: join(demo.directory, 'TOY-REPORT.md'),
      brief: 'Infrastructure only; no scientific conclusions.',
    }),
  );
  writeFileSync(
    join(demo.directory, 'DEMO-TASKS.md'),
    `Public CLI mechanics via POST ${endpoint} JSON {operation,args}. status returns registry; dispatch uses --input absolute JSON file {subject,role,stage,inputRevision,brief,prerequisites,checkout?}. All role init/activation is performed normally. collect --dispatch ID; accept --receipt ID --decision ${decision} [--pr 2]. Inspect evidence yourself. The server never selects a stage. Choose eligible sequencing and assignments.
Toy task graph: planning/epic for toy/epic#1; then implementation/worker for toy/epic#2 checkout ${checkout}; pr-quality/landing; pr-merge/landing (execute --dispatch ID --pr 2 before accept); final-records/worker; preservation-cleanup/landing (terminate with args [ID], then execute before accept). Non-delivery stages use toy/epic#1 and default checkout. Each stage needs accepted predecessor ID in prerequisites; delivery stages share checkout. Use current Git HEAD for inputRevision. Script implementation commits toy.txt; its pre-edit revision becomes stale, so terminate its first dispatch, disposition its published receipt with accept (current-HEAD verification records rejection of the stale revision), then re-dispatch current revision with a different brief if necessary. Process termination alone does not disposition a reported result. After first implementation result the fixture will return existing artifact rather than repeat commit.
After delivery invoke integrate mechanic, then integrated-acceptance/epic; confirmation mechanic creates version-bound fixture human input; close --dispatch acceptance-ID --decision ${join(demo.directory, 'human-closure.json')}. Then pipeline-audit and pipeline-refactor respective roles, pipeline --dispatch accepted-refactor-ID. Finally research-report/research-state, publish --dispatch accepted-report-ID --decision ${coordinator}. Report completion must have all seven roles accepted, legitimate closure and pipeline disposition; evidence retained. Registry resources show occupancy separately. No precomputed dispatch IDs supplied.
The endpoint is already running. Public invocation examples (substitute your chosen IDs and file): POST JSON {"operation":"dispatch","args":["--input","ABSOLUTE_REQUEST_FILE"]}; {"operation":"collect","args":["--dispatch","DISPATCH_ID"]}; {"operation":"accept","args":["--receipt","RECEIPT_ID","--decision","${decision}"]}. Request file is a single JSON object {"subject":"toy/epic#NUMBER","role":"CHOSEN_ROLE","stage":"CHOSEN_STAGE","inputRevision":"GIT_HEAD_SHA","brief":"YOUR_SCOPED_ASSIGNMENT","prerequisites":["ACCEPTED_DISPATCH_ID"],"checkout":"OPTIONAL_DELIVERY_CHECKOUT"}. Omit checkout for project roles and omit optional values rather than sending placeholders. Session binds config/run/authority; do not include those flags. Output {exitCode,output} contains CLI output values; status output[0] is registry. Receipt IDs are in registry.receipts, Dispatch IDs in registry.dispatches; inputRevision comes from git rev-parse HEAD in requested checkout. No implementation-source exploration is needed. You may choose operations directly or write your own local caller; no ready-made schedule is supplied.
`,
  );
  // Implementation is idempotent in this arrangement; retry simply observes the committed artifact.
  const implementation = demo.tasks.get('implementation')!;
  let implemented = false;
  demo.tasks.set('implementation', (a) => {
    if (!implemented) {
      implemented = true;
      return implementation(a);
    }
    return JSON.stringify({
      status: 'completed',
      artifact: join(checkout, 'toy.txt'),
      attempt: a.id,
    });
  });
  console.log(
    JSON.stringify({
      outcome: 'started',
      provider,
      evidenceDirectory: demo.directory,
      run: demo.run.id,
      endpoint,
    }),
  );
  const deadline = Date.now() + Number(process.env.PC_LIVE_DEMO_TIMEOUT_MS ?? 600000);
  while (Date.now() < deadline) {
    await reconcileStartup(demo.config, demo.runner, demo.run.id);
    const registry = inspectRuns(demo.config);
    if (registry.runs.find((r) => r.id === demo!.run.id)?.lifecycle === 'completed') {
      verifyAllRoleOutcome(demo.config, demo.run.id);
      const roles = new Set([
        'orchestrator',
        ...registry.dispatches!.filter((d) => d.lifecycle === 'accepted').map((d) => d.role),
      ]);
      if (
        roles.size !== 7 ||
        !requests.some((r) => (r as { operation: string }).operation === 'dispatch')
      )
        throw new Error('Native scheduling evidence incomplete');
      outcome = 'completed';
      break;
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
  if (outcome !== 'completed')
    throw new Error(
      'Native Orchestrator deadline reached; inspect retained native receipts and CLI requests',
    );
} catch (error) {
  console.error(
    JSON.stringify({
      outcome: 'blocked',
      provider,
      evidenceDirectory: demo?.directory,
      error: String(error),
    }),
  );
  process.exitCode = 1;
} finally {
  if (demo) {
    await native.cancel?.(
      inspectRuns(demo.config).runs.find((r) => r.id === demo!.run.id)!.orchestrator!,
    );
    writeFileSync(
      join(demo.directory, 'live-outcome.json'),
      JSON.stringify({
        outcome,
        requests: requests.length,
        evidenceLevel:
          'Native Orchestrator CLI use; scripted subordinates; no scientific validity claim',
      }),
    );
  }
  server.close();
}
