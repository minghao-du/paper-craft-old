/** Pull Request provider contracts and GitHub CLI adapter. */
import { execFileSync } from 'node:child_process';

/** Repository-scoped delivery; EPIC professional evidence is bound to its head. */
export interface PrDelivery {
  repository: string;
  issue: number;
  checkout: string;
  epic?: number;
  confirmation?: { epic: number; head: string; evidence: string };
  /** Re-evaluate professional approval whenever the live head changes. */
  confirmHead?: (head: string) => Promise<{ epic: number; head: string; evidence: string }>;
}

/** Live provider evidence and compare-and-merge operation. */
export interface PullRequestProvider {
  ensure(delivery: PrDelivery): Promise<number>;
  read(pr: number): Promise<{
    head: string;
    state: string;
    conflict: boolean;
    mergeCommit?: string;
    repository?: string;
    issues?: number[];
  }>;
  checks(pr: number): Promise<'passed' | 'failed' | 'pending'>;
  merge(pr: number, head: string): Promise<void>;
}

/** GitHub CLI adapter; checks and atomic expected-head merge remain provider operations. */
export class GitHubPullRequests implements PullRequestProvider {
  constructor(
    private readonly checkout: string,
    private readonly repository: string,
  ) {}

  private gh(args: string[]): string {
    return execFileSync('gh', args, { cwd: this.checkout, encoding: 'utf8' }).trim();
  }

  /** Reuse a branch PR, or create one from delivered commits. */
  async ensure(): Promise<number> {
    const prs = JSON.parse(
      this.gh([
        'pr',
        'list',
        '--repo',
        this.repository,
        '--head',
        execFileSync('git', ['branch', '--show-current'], {
          cwd: this.checkout,
          encoding: 'utf8',
        }).trim(),
        '--json',
        'number',
      ]),
    );
    if (prs.length) return prs[0].number;
    execFileSync('git', ['push', '-u', 'origin', 'HEAD'], { cwd: this.checkout });
    this.gh(['pr', 'create', '--repo', this.repository, '--fill']);
    return JSON.parse(this.gh(['pr', 'view', '--json', 'number'])).number;
  }

  /** Read the live head and merge status again at each decision. */
  async read(pr: number) {
    const p = JSON.parse(
      this.gh([
        'pr',
        'view',
        String(pr),
        '--repo',
        this.repository,
        '--json',
        'headRefOid,state,mergeable,mergeCommit,closingIssuesReferences',
      ]),
    );
    return {
      head: p.headRefOid,
      state: p.state,
      conflict: p.mergeable !== 'MERGEABLE',
      mergeCommit: p.mergeCommit?.oid,
      repository: this.repository,
      issues: p.closingIssuesReferences.map((i: { number: number }) => i.number),
    };
  }

  /** Verify merge state before post-merge side effects. */
  async merged(pr: number): Promise<boolean> {
    return (await this.read(pr)).state === 'MERGED';
  }

  /** GitHub close is idempotent; verify actual state after the request. */
  async close(issue: number): Promise<void> {
    const args = ['issue', 'view', String(issue), '--repo', this.repository, '--json', 'state'];
    if (JSON.parse(this.gh(args)).state !== 'CLOSED')
      this.gh(['issue', 'close', String(issue), '--repo', this.repository]);
    if (JSON.parse(this.gh(args)).state !== 'CLOSED') throw new Error('Issue closure not verified');
  }

  /** Required check results only; no required checks is permitted. */
  async checks(pr: number): Promise<'passed' | 'failed' | 'pending'> {
    let raw: string;
    try {
      raw = this.gh([
        'pr',
        'checks',
        String(pr),
        '--repo',
        this.repository,
        '--required',
        '--json',
        'bucket',
      ]);
    } catch (error) {
      const stderr = String((error as { stderr?: string }).stderr ?? '');
      if (/no (required )?checks reported/i.test(stderr)) return 'passed';
      const stdout = (error as { stdout?: string }).stdout;
      if (!stdout) throw error;
      raw = stdout;
    }
    const checks = JSON.parse(raw) as { bucket: string }[];
    return checks.some((c) => ['fail', 'cancel'].includes(c.bucket))
      ? 'failed'
      : checks.some((c) => c.bucket !== 'pass' && c.bucket !== 'skipping')
        ? 'pending'
        : 'passed';
  }

  /** GitHub rejects a moved head instead of merging unchecked commits. */
  async merge(pr: number, head: string) {
    if (
      execFileSync('git', ['status', '--porcelain'], {
        cwd: this.checkout,
        encoding: 'utf8',
      }).trim()
    )
      throw new Error('Worker must account for dirty checkout before merge');
    if (
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: this.checkout,
        encoding: 'utf8',
      }).trim() !== head
    )
      throw new Error('Local HEAD differs from evaluated PR head');
    const base = JSON.parse(
      this.gh(['pr', 'view', String(pr), '--repo', this.repository, '--json', 'baseRefName']),
    ).baseRefName;
    execFileSync('git', ['fetch', 'origin', base], { cwd: this.checkout });
    execFileSync('git', ['merge-base', '--is-ancestor', `origin/${base}`, head], {
      cwd: this.checkout,
    });
    this.gh([
      'pr',
      'merge',
      String(pr),
      '--repo',
      this.repository,
      '--squash',
      '--match-head-commit',
      head,
    ]);
  }
}
