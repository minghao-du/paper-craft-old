import { execFileSync } from 'node:child_process';

/** Verified repository-scoped issue input from an issue tracker. */
export interface IssueInput {
  repository: string;
  number: number;
  title: string;
  body: string;
  parent?: number;
  /** Open tracker dependencies; undefined on a child is unresolved metadata. */
  blockedBy?: number[];
}

function repository(project: string): string {
  return execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
    cwd: project,
    encoding: 'utf8',
  }).trim();
}

/** Read GitHub identity and parent directly; API failures remain errors. */
export function readIssue(project: string, number: number): IssueInput {
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error('Expected positive issue number');
  const repo = repository(project);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Expected GitHub repository owner/name');
  const data = JSON.parse(
    execFileSync(
      'gh',
      [
        'api',
        'graphql',
        '-f',
        `query=query { repository(owner: "${repo.split('/')[0]}", name: "${repo.split('/')[1]}") { nameWithOwner issue(number: ${number}) { number title body parent { number } } } }`,
      ],
      { cwd: project, encoding: 'utf8' },
    ),
  );
  if (data.errors || !data.data?.repository?.issue)
    throw new Error('Expected accessible GitHub issue and parent evidence');
  const r = data.data.repository;
  const dependencies = JSON.parse(
    execFileSync('gh', ['api', `repos/${repo}/issues/${number}/dependencies/blocked_by`], {
      cwd: project,
      encoding: 'utf8',
    }),
  );
  if (!Array.isArray(dependencies))
    throw new Error('Expected accessible GitHub issue dependencies');
  return {
    ...r.issue,
    repository: r.nameWithOwner,
    parent: r.issue.parent?.number,
    blockedBy: dependencies
      .filter((d: { state: string }) => d.state !== 'closed')
      .map((d: { number: number }) => d.number),
  };
}
