import { demoArtifacts } from './artifacts.js';
import { demoChronology } from './delivery.js';
import { pipelineAccepted } from '../delivery/epic-finalization.js';
/** Independent round inspection. Controlled samples exercise detection, never live acceptance. */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { DemoRound } from './round.js';
import { inspectRunViews, type WorkflowRunView } from '../run/run-driver.js';
import { loadFleetConfig } from '../fleet/fleet-config.js';
import { type ManagedAttempt, inspectAttemptControl } from '../runtime/runtime.js';
import { DemoFinalization, nativeDemoFinalization, type DemoFinalizationView } from './finalization.js';
import type { GateAuthorization } from './delivery.js';

/** A diagnostic retains the fact, expectation and source instead of only a boolean. */
export interface DemoCheck {
  stage: string;
  expected: string;
  observed: string;
  verdict: 'pass' | 'finding' | 'missing';
  reference?: string;
}
/** Independent dimensions never reinterpret Run completion as resource release. */
export interface DemoEvidence {
  source: 'native' | 'controlled';
  references: string[];
  checks: DemoCheck[];
  business: 'pending' | 'completed' | 'failed' | 'stopped';
  execution: 'released' | 'unknown';
  cleanup: 'pending' | 'retained' | 'completed' | 'failed';
}
/** Only collection adapters may replace external facts in cheap offline checker tests. */
export interface DemoEvidenceReader {
  collect(round: DemoRound, boundary: string): Promise<DemoEvidence>;
}
/** Report is diagnostic evidence, not an authorization to delete resources. */
export interface DemoVerification extends DemoEvidence {
  boundary: string;
  defects: 'clear' | 'findings' | 'inconclusive';
  checksNotRun: string[];
  limitations: string[];
  clean: boolean;
}
/** Public persisted verification entry point; earlier violations cannot be erased by later success. */
export class DemoVerifier {
  constructor(readonly reader: DemoEvidenceReader = nativeDemoEvidence()) {}
  /** Inspect at a stage boundary or at the end and retain every diagnostic. */
  async verify(round: DemoRound, boundary = 'final'): Promise<DemoVerification> {
    const history = join(round.root, 'verification.jsonl');
    const previous: DemoVerification[] = existsSync(history)
      ? readFileSync(history, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
    let evidence: DemoEvidence;
    try {
      evidence = await this.reader.collect(round, boundary);
    } catch (error) {
      evidence = {
        source: 'native',
        references: [round.root],
        checks: [
          {
            stage: boundary,
            expected: 'Readable independent evidence',
            observed: String(error),
            verdict: 'missing',
            reference: round.root,
          },
        ],
        business: 'pending',
        execution: 'unknown',
        cleanup: 'retained',
      };
    }
    const checks = [
      ...previous.flatMap((result) => result.checks.filter((check) => check.verdict === 'finding')),
      ...evidence.checks,
    ];
    const checksNotRun = checks.filter((c) => c.verdict === 'missing').map((c) => c.expected);
    if (!checks.length) checksNotRun.push('No independent checks were collected');
    const defects: 'clear' | 'findings' | 'inconclusive' = checks.some((c) => c.verdict === 'finding')
      ? 'findings'
      : checksNotRun.length
        ? 'inconclusive'
        : 'clear';
    const clean =
      evidence.business === 'completed' &&
      defects === 'clear' &&
      evidence.execution === 'released' &&
      evidence.cleanup !== 'failed';
    const result: DemoVerification = {
      ...evidence,
      checks,
      boundary,
      checksNotRun,
      defects,
      clean,
      limitations: [
        'A pass cannot prove absence of all bugs.',
        ...(evidence.source === 'controlled'
          ? ['Controlled checker sample: not live Agy/GitHub acceptance.']
          : []),
      ],
    };
    appendFileSync(history, JSON.stringify(result) + '\n');
    return result;
  }
}
/** Additional independent readers supplied by delivery and isolated-validation integration.
 * Readers must inspect source evidence, never copy agent assertions or cached verdicts.
 * Chronology inspects historical dispatch/acceptance/release facts; artifacts executes
 * immutable merged scripts/tests in an owned temporary directory with changed input.
 */
export interface DemoBoundaryReaders {
  /** GitHub system boundary; controlled raw metadata is not live acceptance. */
  github?(path: string): ReturnType<typeof JSON.parse>;
  /** External process observation; controlled values cannot establish live acceptance. */
  termination?(attempt: ManagedAttempt): Promise<boolean>;
  chronology?(round: DemoRound): Promise<DemoCheck[]>;
  artifacts?(round: DemoRound, revision?: string, stage?: 'first' | 'final'): Promise<DemoCheck[]>;
  finalization?(round: DemoRound): Promise<DemoFinalizationView>;
}
/** Read actual GitHub metadata, immutable Git objects and public managed-runtime state. */
export function nativeDemoEvidence(readers: DemoBoundaryReaders = {}): DemoEvidenceReader {
  readers = { chronology: demoChronology, artifacts: demoArtifacts, ...readers };
  return {
    async collect(round, boundary) {
      if (!round.repository || !round.parent)
        throw new Error('Provisioned repository and Parent required');
      const repo = `${round.repository.owner}/${round.repository.name}`;
      const gh =
        readers.github ??
        ((path: string) =>
          JSON.parse(
            execFileSync('gh', ['api', path], {
              encoding: 'utf8',
              timeout: 30000,
              maxBuffer: 4 * 1024 * 1024,
            }),
          ));
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: round.checkout, encoding: 'utf8', timeout: 10000 }).trim();
      const checks: DemoCheck[] = [];
      const check = (
        stage: string,
        expected: string,
        pass: boolean | undefined,
        observed: unknown,
        reference = repo,
      ) =>
        checks.push({
          stage,
          expected,
          observed: JSON.stringify(observed),
          verdict: pass === undefined ? 'missing' : pass ? 'pass' : 'finding',
          reference,
        });

      const identity = gh(`repos/${repo}`);
      check(
        'ownership',
        'Recorded GitHub repository identity',
        identity.id === round.repository.id,
        identity.id,
      );
      const children: { number: number }[] = gh(
        `repos/${repo}/issues/${round.parent}/sub_issues?per_page=100`,
      );
      check('structure', 'Exactly two native child tasks', children.length === 2, children);
      if (children.length === 2) {
        const c0 = children[0].number;
        const c1 = children[1].number;
        let blockers: { number: number }[] = [];
        try {
          blockers = gh(`repos/${repo}/issues/${c1}/dependencies/blocked_by`);
        } catch {
          /* ignore */
        }
        let blockers0: { number: number }[] = [];
        try {
          blockers0 = gh(`repos/${repo}/issues/${c0}/dependencies/blocked_by`);
        } catch {
          /* ignore */
        }
        const validDep =
          (blockers.length === 1 && blockers[0].number === c0) ||
          (blockers0.length === 1 && blockers0[0].number === c1);
        check(
          'structure',
          'Second child natively blocked by first',
          validDep,
          blockers.length ? blockers : blockers0,
        );
      }
      const prs: {
        number: number;
        merged_at: string | null;
        merge_commit_sha: string;
        head: { sha: string };
      }[] = gh(`repos/${repo}/pulls?state=all&per_page=100`);
      check(
        'delivery',
        'Exactly two task PRs',
        prs.length === 2,
        prs.map((p) => p.number),
      );

      const configPath = round.workflowConfigFile ?? join(round.checkout, '.epic-config.json');
      const config = existsSync(configPath) ? loadFleetConfig(configPath) : undefined;
      let runViews: WorkflowRunView[] = [];
      if (config) {
        try {
          runViews = inspectRunViews(config);
        } catch {
          /* ignore */
        }
      }
      const runs = runViews.filter(
        (r) => r.subject.repository === repo && r.subject.number === round.parent,
      );
      check(
        'runtime',
        'One attributable Agy Run',
        runs.length === 1 && runs[0].provider === 'agy',
        runs.map((r) => ({ id: r.id, provider: r.provider })),
      );
      const run = runs[0];
      const dispatches = run?.dispatches ?? [];
      const workerSubjects = new Set(
        dispatches.filter((d) => d.role === 'worker').map((d) => d.subject),
      );
      check(
        'delivery',
        'Exactly two child Worker task identities',
        workerSubjects.size === 2 &&
          children.every((c) => workerSubjects.has(`${repo}#${c.number}`)),
        [...workerSubjects],
      );

      const receipts = run?.receipts ?? [];
      for (const d of dispatches) {
        check(
          'attribution',
          'Agy dispatch and stage-matched accepted Receipt',
          d.provider === 'agy' &&
            d.attempts.length === 1 &&
            receipts.some(
              (r) =>
                r.id === d.acceptedReceipt &&
                r.dispatchId === d.id &&
                r.runId === d.runId &&
                r.role === d.role &&
                r.stage === d.stage &&
                r.provider === 'agy' &&
                r.subject === d.subject &&
                r.inputRevision === d.inputRevision &&
                d.attempts.some((a) => a.id === r.attemptId),
            ),
          d.id,
        );
      }

      const g1File = join(round.root, 'gate-worker1-authorization.json');
      const g2File = join(round.root, 'gate-worker2-authorization.json');
      const jsonlFile = join(round.root, 'gate-authorizations.jsonl');
      const gateAuthFile = join(round.root, 'gate-authorization.json');

      let g1Auth: GateAuthorization | undefined;
      let g2Auth: GateAuthorization | undefined;
      if (existsSync(g1File)) {
        try {
          g1Auth = JSON.parse(readFileSync(g1File, 'utf8'));
        } catch {
          /* ignore */
        }
      }
      if (existsSync(g2File)) {
        try {
          g2Auth = JSON.parse(readFileSync(g2File, 'utf8'));
        } catch {
          /* ignore */
        }
      }
      if (existsSync(jsonlFile)) {
        try {
          const list = readFileSync(jsonlFile, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line));
          g1Auth ??= list.find(
            (a: { gate?: string; issue?: number }) =>
              a.gate === 'worker1' || a.issue === children[0]?.number,
          );
          g2Auth ??= list.find(
            (a: { gate?: string; issue?: number }) =>
              a.gate === 'worker2' || a.issue === children[1]?.number,
          );
        } catch {
          /* ignore */
        }
      }

      let gateAuth: GateAuthorization | undefined;
      if (existsSync(gateAuthFile)) {
        try {
          gateAuth = JSON.parse(readFileSync(gateAuthFile, 'utf8'));
        } catch {
          /* ignore */
        }
      }

      if (!g1Auth && !g2Auth && gateAuth) {
        const validGateAuth = Boolean(
          gateAuth &&
            gateAuth.roundId === round.id &&
            gateAuth.runId === run?.id &&
            gateAuth.claimed === true,
        );
        check(
          'attribution',
          'Retained Gate authorization evidence',
          gateAuth ? validGateAuth : undefined,
          gateAuth ?? 'Missing gate-authorization.json',
          gateAuthFile,
        );
      } else {
        const validG1 = Boolean(
          g1Auth &&
            g1Auth.roundId === round.id &&
            g1Auth.runId === run?.id &&
            g1Auth.claimed === true,
        );
        const validG2 = Boolean(
          g2Auth &&
            g2Auth.roundId === round.id &&
            g2Auth.runId === run?.id &&
            g2Auth.claimed === true,
        );
        const validChronology = Boolean(
          validG1 &&
            validG2 &&
            g1Auth?.authorizedAt &&
            g2Auth?.authorizedAt &&
            Date.parse(g1Auth.authorizedAt) <= Date.parse(g2Auth.authorizedAt),
        );
        check(
          'attribution',
          'Retained Gate 1 and Gate 2 authorization history',
          g1Auth || g2Auth ? validG1 && validG2 : undefined,
          { gate1: g1Auth, gate2: g2Auth },
          existsSync(jsonlFile) ? jsonlFile : g1File,
        );
        check(
          'ordering',
          'Gate 1 authorized before Gate 2',
          g1Auth && g2Auth ? validChronology : undefined,
          { gate1AuthorizedAt: g1Auth?.authorizedAt, gate2AuthorizedAt: g2Auth?.authorizedAt },
          existsSync(jsonlFile) ? jsonlFile : g2File,
        );
      }

      const deliveries = run?.deliveries ?? [];
      const pullRequests = run?.pullRequests ?? [];
      for (const pr of prs) {
        const delivery = deliveries.find((d) => d.pr === pr.number);
        const recorded = pullRequests.find(
          (p) => p.runId === run?.id && p.pr === pr.number,
        );
        check(
          'landing',
          'Merged tested/reviewed HEAD with Final Records and release',
          Boolean(
            pr.merged_at &&
            delivery?.recorded &&
            delivery.released &&
            delivery.archive &&
            delivery.checkedHead === pr.head.sha &&
            recorded?.checkedHead === pr.head.sha &&
            recorded.mergeCommit === pr.merge_commit_sha,
          ),
          { pr: pr.number, delivery, recorded },
        );
        if (delivery?.archive)
          check(
            'landing',
            'Preserved delivery archive exists',
            existsSync(delivery.archive),
            delivery.archive,
          );
      }

      if (boundary !== 'structure' && readers.chronology)
        checks.push(...(await readers.chronology(round)));
      else
        check(
          'ordering',
          'Independent historical Worker 2 start after full Worker 1 handover',
          undefined,
          'Chronology evidence required; final delivery state is insufficient',
        );

      const merged = prs
        .filter((p) => p.merged_at)
        .sort((a, b) => String(a.merged_at).localeCompare(String(b.merged_at)));
      if (boundary !== 'structure' && merged.length === 2) {
        const first = merged[0].merge_commit_sha,
          last = merged[1].merge_commit_sha;
        const worker2 = dispatches.find(
          (d) => d.role === 'worker' && d.subject.endsWith(`#${children[1]?.number}`),
        );
        let contains = false;
        if (worker2) {
          try {
            git('merge-base', '--is-ancestor', first, worker2.inputRevision);
            contains = true;
          } catch {
            /* independently detected non-ancestor */
          }
        }
        check(
          'ordering',
          'Worker 2 starting revision contains merged PR 1',
          contains,
          worker2?.inputRevision,
        );
        const tsv = execFileSync('git', ['show', `${last}:data.tsv`], {
          cwd: round.checkout,
          encoding: 'utf8',
          timeout: 10000,
        }).replace(/\n$/, '');
        check(
          'artifacts',
          'Exact ten-row id/value TSV',
          tsv ===
            'id\tvalue\n1\t10\n2\t20\n3\t30\n4\t40\n5\t50\n6\t60\n7\t70\n8\t80\n9\t90\n10\t100',
          tsv,
          last,
        );
        const summary = JSON.parse(git('show', `${last}:summary.json`));
        check(
          'artifacts',
          'Only n=10 mean=55 min=10 max=100',
          Object.keys(summary).length === 4 &&
            summary.n === 10 &&
            summary.mean === 55 &&
            summary.min === 10 &&
            summary.max === 100,
          summary,
          last,
        );
      }

      if (boundary !== 'structure' && readers.artifacts) {
        if (merged.length === 2)
          checks.push(...(await readers.artifacts(round, merged[0].merge_commit_sha, 'first')));
        checks.push(
          ...(await readers.artifacts(
            round,
            merged.length === 2 ? merged[1].merge_commit_sha : undefined,
          )),
        );
      } else
        check(
          'artifacts',
          'Isolated script re-execution and changed-input computation',
          undefined,
          'Requires isolated validation; committed outputs alone are insufficient',
        );

      const parent = gh(`repos/${repo}/issues/${round.parent}`);
      const humanClosureFile = join(round.root, 'human-closure.json');
      let humanConsent: { deliveryVersion?: string; source?: string; evidence?: string } | undefined;
      if (existsSync(humanClosureFile)) {
        try {
          humanConsent = JSON.parse(readFileSync(humanClosureFile, 'utf8'));
        } catch {
          /* ignore */
        }
      }
      const validHumanConsent = Boolean(
        humanConsent &&
          humanConsent.source === 'human' &&
          humanConsent.deliveryVersion &&
          run?.epicClosure?.deliveryVersion &&
          humanConsent.deliveryVersion === run.epicClosure.deliveryVersion &&
          humanConsent.evidence,
      );
      check(
        'closure',
        'Retained human closure consent evidence',
        humanConsent ? validHumanConsent : undefined,
        humanConsent ?? 'Missing human-closure.json',
        humanClosureFile,
      );
      check(
        'closure',
        'Actual closed Parent with delivery-bound human confirmation',
        Boolean(
          parent.state === 'closed' &&
            validHumanConsent &&
            run?.epicClosure?.deliveryVersion &&
            run.epicClosure.head === git('rev-parse', 'HEAD'),
        ),
        { state: parent.state, closure: run?.epicClosure, humanConsent },
      );

      let finView: DemoFinalizationView | undefined;
      if (readers.finalization) {
        try {
          finView = await readers.finalization(round);
        } catch {
          /* ignore */
        }
      } else {
        try {
          const finalization = new DemoFinalization(round, nativeDemoFinalization(round, readers.github));
          finView = await finalization.view();
        } catch {
          /* fallback */
        }
      }

      const pipeAccepted = Boolean(
        (finView?.pipeline?.accepted ?? (run?.pipeline && pipelineAccepted(run.pipeline))) &&
          (finView?.pipeline?.head ?? run?.pipeline?.head) === (run?.epicClosure?.head ?? '') &&
          Object.values((finView?.pipeline?.inspectedVersions ?? run?.pipeline?.inspectedVersions) ?? {}).includes(run?.epicClosure?.head ?? ''),
      );
      check(
        'finalization',
        'Accepted Pipeline disposition',
        pipeAccepted,
        finView?.pipeline ?? run?.pipeline,
      );

      let reportValid = false;
      const report = run?.report;
      if (finView?.report) {
        reportValid = finView.report.published;
      } else if (report && report.path === round.entry && existsSync(round.entry)) {
        reportValid =
          createHash('sha256').update(readFileSync(round.entry)).digest('hex') === report.hash &&
          Boolean(report.receipt && report.revision && existsSync(report.receipt)) &&
          report.acceptedVersions?.integrated === run?.epicClosure?.head &&
          report.observedVersions?.integrated === run?.epicClosure?.head &&
          JSON.parse(readFileSync(report.receipt, 'utf8')).hash === report.hash &&
          JSON.parse(readFileSync(report.receipt, 'utf8')).path === round.entry;
      }
      check(
        'publication',
        'Isolated transactional Research-State publication with matching hash',
        reportValid,
        finView?.report ?? report,
      );

      const attempts = run?.attempts ?? [];
      let released = attempts.length > 0;
      for (const attempt of attempts) {
        const control = inspectAttemptControl(attempt);
        const stopped = readers.termination
          ? await readers.termination(attempt)
          : control.execution?.status === 'terminated';
        if (!stopped || control.execution?.status !== 'terminated') released = false;
      }
      if ((run?.resources ?? []).length > 0) released = false;
      if (run?.helper?.active) released = false;
      check(
        'execution',
        'All historical executions terminated and ownership released',
        released,
        attempts.map((a) => a.id),
      );

      const controlPath = join(round.root, 'control.json');
      const control:
        | {
            runId?: string;
            stopped?: boolean;
            execution?: string;
            observations?: {
              id: string;
              disposition?: { reason?: string; status?: string } | string;
            }[];
          }
        | undefined = existsSync(controlPath)
        ? JSON.parse(readFileSync(controlPath, 'utf8'))
        : undefined;
      check(
        'observations',
        'Attributable observation journal with no unresolved observations',
        control
          ? control.runId !== run?.id
            ? false
            : (control.observations ?? []).every(
                  (o) =>
                    typeof o.disposition === 'object' &&
                    o.disposition.status === 'false_alarm' &&
                    Boolean(o.disposition.reason?.trim()),
                )
              ? true
              : undefined
          : undefined,
        control,
        controlPath,
      );
      if (control?.execution !== 'released') released = false;
      check(
        'execution',
        'Aggregate helper and ownership release',
        control ? control.execution === 'released' : undefined,
        control?.execution,
        controlPath,
      );

      const stages: Record<string, string[]> = {
        structure: ['ownership', 'structure', 'observations'],
        delivery: [
          'ownership',
          'structure',
          'delivery',
          'attribution',
          'landing',
          'ordering',
          'artifacts',
          'observations',
        ],
        closure: [
          'ownership',
          'structure',
          'delivery',
          'attribution',
          'landing',
          'ordering',
          'artifacts',
          'closure',
          'observations',
        ],
        finalization: [
          'ownership',
          'structure',
          'delivery',
          'attribution',
          'landing',
          'ordering',
          'artifacts',
          'closure',
          'finalization',
          'publication',
          'observations',
        ],
      };
      if (boundary !== 'final' && !stages[boundary])
        throw new Error(
          'Expected structure, delivery, closure, finalization or final verification boundary',
        );

      return {
        source: readers.github || readers.termination || readers.finalization ? 'controlled' : 'native',
        references: [repo, configPath],
        checks:
          boundary === 'final' ? checks : checks.filter((c) => stages[boundary].includes(c.stage)),
        business:
          run?.lifecycle === 'completed'
            ? 'completed'
            : run?.lifecycle === 'blocked'
              ? 'failed'
              : 'pending',
        execution: released ? 'released' : 'unknown',
        cleanup: 'pending',
      };
    },
  };
}
