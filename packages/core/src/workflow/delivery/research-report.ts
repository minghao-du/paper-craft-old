/** Transactional report publication at the canonical Project destination. */
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Verified report identity retained in immutable workflow history. */
export interface ResearchReport {
  path: string;
  hash: string;
  revision: string;
  evidence: string[];
  receipt: string;
  acceptedVersions: Record<string, string>;
  observedVersions: Record<string, string>;
}
/** Publish only a validated candidate; one physical destination has one writer across Fleets. */
export async function writeResearchReport(
  coordinator: { identity: string; entry: string; brief: string },
  facts: {
    objective: string;
    acceptedVersions: Record<string, string>;
    observedVersions: Record<string, string>;
    pipeline: unknown;
    closureEvidence: string;
  },
  write: (brief: string, writableDirectories: string[]) => Promise<string[]>,
): Promise<ResearchReport> {
  const destination = existsSync(coordinator.entry)
    ? realpathSync(coordinator.entry)
    : join(realpathSync(dirname(coordinator.entry)), basename(coordinator.entry));
  const lock = destination + '.writer-lock';
  try {
    mkdirSync(lock);
  } catch {
    throw new Error('Research destination occupied; reconcile prior writer before retry');
  }
  const revision = randomUUID();
  const staging = join(dirname(destination), '.report-' + revision);
  mkdirSync(staging);
  const candidate = join(staging, basename(destination));
  let writerReturned = false;
  try {
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ coordinator, revision, destination }));
    const evidence = await write(
      `Invoke /pc-research-state using designated coordinator ${JSON.stringify(coordinator)}. Write ONLY the candidate report ${candidate}; do not modify the published report ${destination}. Original objective and version-bound evidence: ${JSON.stringify(facts)}. Distinguish accepted EPIC versions from observed repository versions and unrelated concurrent changes. Include these headings: Objective, Accepted delivery versions, Observed repository versions, Pipeline disposition, Verified findings, Interpretation, Missing evidence, Follow-up Issues, Limitations. Do not infer scientific results from infrastructure progress. Return normal completed research receipt with evidence after verifying the candidate.`,
      [staging],
    );
    writerReturned = true;
    const body = readFileSync(candidate, 'utf8');
    for (const heading of [
      'Objective',
      'Accepted delivery versions',
      'Observed repository versions',
      'Pipeline disposition',
      'Verified findings',
      'Interpretation',
      'Missing evidence',
      'Follow-up Issues',
      'Limitations',
    ])
      if (!body.includes(heading)) throw new Error('Report missing required section: ' + heading);
    if (!evidence.length) throw new Error('Report requires verification evidence');
    // Runtime-owned attribution survives model omission or accidental credit to concurrent work.
    const published =
      body + '\n\n<!-- Verified workflow provenance\n' + JSON.stringify(facts) + '\n-->\n';
    writeFileSync(candidate, published);
    const hash = createHash('sha256').update(published).digest('hex');
    const receipts = destination + '.receipts';
    mkdirSync(receipts, { recursive: true });
    const receipt = join(receipts, revision + '.json');
    const record = {
      path: destination,
      hash,
      revision,
      evidence,
      receipt,
      acceptedVersions: facts.acceptedVersions,
      observedVersions: facts.observedVersions,
    };
    writeFileSync(receipt, JSON.stringify(record), { flag: 'wx', mode: 0o400 });
    renameSync(candidate, destination);
    return {
      path: destination,
      hash,
      revision,
      evidence,
      receipt,
      acceptedVersions: facts.acceptedVersions,
      observedVersions: facts.observedVersions,
    };
  } finally {
    if (writerReturned) {
      rmSync(staging, { recursive: true, force: true });
      rmSync(lock, { recursive: true, force: true });
    }
  }
}

/** Release an interrupted writer only after independent proof that its execution stopped. */
export async function releaseResearchWriter(
  destination: string,
  verifyStopped: (owner: { revision: string }) => Promise<boolean>,
): Promise<void> {
  if (!existsSync(dirname(destination))) return;
  const physical = existsSync(destination)
    ? realpathSync(destination)
    : join(realpathSync(dirname(destination)), basename(destination));
  if (!existsSync(physical + '.writer-lock')) return;
  const owner = JSON.parse(readFileSync(join(physical + '.writer-lock', 'owner.json'), 'utf8'));
  if (!(await verifyStopped(owner))) throw new Error('Research writer termination unverified');
  rmSync(physical + '.writer-lock', { recursive: true, force: true });
}
