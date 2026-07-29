/**
 * Whether a backend's web search is actually working, judged from its own runs.
 *
 * The failure this exists for: a CLI joins the free lane, its web search is
 * broken (signed out, rate limited, sandboxed, or a scrubbed environment it did
 * not expect), and instead of failing it writes a fluent report explaining why
 * it could not research. That lands `completed`. `mergeContribution` already
 * catches it, but only inside one panel and only after the slot is spent, and
 * nothing survives the run, so the same backend joins the next panel with a
 * clean slate and does it again.
 *
 * **Why this is a record rather than a probe.** The obvious design is a
 * pre-flight: ask each CLI to search for something and check it comes back with
 * a citation. That costs a real invocation against a subscription quota, per
 * backend, per run, to learn something the previous run already demonstrated for
 * free. A probe also answers a slightly different question than the one that
 * matters, since a CLI can pass a trivial search and still fail on a hard one.
 * Real outcomes are cheaper AND better evidence, so the only thing missing was
 * writing them down.
 *
 * What this is NOT: a judgement about report quality. A run that cited nothing
 * is the single specific pathology of a search that did not run. A thin report
 * with three good sources is not this file's business.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const FILE = 'search-health.json';

/** How many recent outcomes are kept per backend. */
export const WINDOW = 5;

/**
 * Consecutive sourceless runs before a backend is called failing.
 *
 * Two, not one. A single sourceless run happens for reasons that are not the
 * backend's search: a question with genuinely no coverage, a cancelled run, a
 * transient upstream outage. Two in a row is a pattern; one is a Tuesday.
 */
export const FAILING_STREAK = 2;

const OutcomeSchema = z.object({
  /** Epoch ms of the run's terminal state. */
  at: z.number(),
  /** Cited sources in the finished report. Zero is the signal. */
  sources: z.number().int().min(0),
});

const FileSchema = z.record(z.string(), z.array(OutcomeSchema));

export type Outcome = z.infer<typeof OutcomeSchema>;
export type Health = 'healthy' | 'failing' | 'unknown';

export function searchHealthPath(storeDir: string): string {
  return join(storeDir, FILE);
}

/**
 * Every recorded outcome, keyed by backend id.
 *
 * Same split as the run store: a malformed *item* is skipped so one bad record
 * cannot hide the rest, and a malformed *envelope* yields nothing rather than
 * being half-believed.
 */
export function readSearchHealth(storeDir: string): ReadonlyMap<string, Outcome[]> {
  const out = new Map<string, Outcome[]>();
  let raw: string;
  try {
    raw = readFileSync(searchHealthPath(storeDir), 'utf8');
  } catch {
    return out;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }

  const envelope = FileSchema.safeParse(parsed);
  if (!envelope.success) return out;

  for (const [backend, outcomes] of Object.entries(envelope.data)) {
    const kept = outcomes.filter((o) => OutcomeSchema.safeParse(o).success);
    if (kept.length > 0) out.set(backend, kept.slice(-WINDOW));
  }
  return out;
}

/** Append one run's outcome, keeping only the recent window. */
export async function recordSearchOutcome(
  storeDir: string,
  backend: string,
  sources: number,
  now: number = Date.now(),
): Promise<void> {
  const current = new Map(readSearchHealth(storeDir));
  const existing = current.get(backend) ?? [];
  current.set(backend, [...existing, { at: now, sources }].slice(-WINDOW));

  const obj: Record<string, Outcome[]> = {};
  for (const [k, v] of current) obj[k] = v;

  // Write-then-rename with the same 0700/0600 modes as the model cache beside
  // it: this file records which backends are misbehaving, which is not
  // something to leave world-readable in a shared temp directory.
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  const path = searchHealthPath(storeDir);
  const tmp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}

/**
 * What the record says about one backend.
 *
 * `unknown` is a real answer and is returned whenever there is not enough
 * evidence, rather than being folded into `healthy`. A backend nobody has run
 * is not a backend known to work, and saying so is the difference between a
 * check and a decoration.
 */
export function healthOf(outcomes: readonly Outcome[] | undefined): Health {
  if (!outcomes || outcomes.length === 0) return 'unknown';
  const recent = outcomes.slice(-FAILING_STREAK);
  if (recent.length >= FAILING_STREAK && recent.every((o) => o.sources === 0)) return 'failing';
  if (outcomes.some((o) => o.sources > 0)) return 'healthy';
  return 'unknown';
}

/** One line per backend with something worth saying. Empty when all is well. */
export function describeSearchHealth(record: ReadonlyMap<string, Outcome[]>): string[] {
  const lines: string[] = [];
  for (const [backend, outcomes] of record) {
    if (healthOf(outcomes) !== 'failing') continue;
    const n = outcomes.slice(-FAILING_STREAK).length;
    lines.push(
      `- **${backend}**: the last ${String(n)} runs finished but cited nothing, which is what a broken web search looks like. ` +
        'Check it is signed in and can reach the network; a backend in this state writes a fluent report about why it could not research.',
    );
  }
  return lines;
}

const PROBE_FILE = 'cli-search-probe.json';

/**
 * How long a search probe is believed.
 *
 * Far shorter than the model cache's 30 days, because the two facts decay at
 * completely different rates. A CLI's model changes when someone changes a
 * setting; its ability to search breaks when a session expires, a rate limit
 * trips, or a network changes, none of which anyone does deliberately. A day-old
 * "search works" is a claim about yesterday.
 */
export const PROBE_TRUSTED_MS = 12 * 60 * 60 * 1000;

const ProbeSchema = z.object({
  state: z.enum(['working', 'no_search', 'unverified', 'refused', 'failed']),
  at: z.number(),
  detail: z.string().max(500).optional(),
});
const ProbeFileSchema = z.record(z.string(), ProbeSchema);

export type ProbeRecord = z.infer<typeof ProbeSchema>;

export function searchProbePath(storeDir: string): string {
  return join(storeDir, PROBE_FILE);
}

export function readSearchProbes(storeDir: string): ReadonlyMap<string, ProbeRecord> {
  const out = new Map<string, ProbeRecord>();
  let raw: string;
  try {
    raw = readFileSync(searchProbePath(storeDir), 'utf8');
  } catch {
    return out;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  const envelope = ProbeFileSchema.safeParse(parsed);
  if (!envelope.success) return out;
  for (const [backend, rec] of Object.entries(envelope.data)) out.set(backend, rec);
  return out;
}

export async function writeSearchProbes(
  storeDir: string,
  results: ReadonlyMap<string, ProbeRecord>,
): Promise<void> {
  if (results.size === 0) return;
  const merged: Record<string, ProbeRecord> = {};
  for (const [k, v] of readSearchProbes(storeDir)) merged[k] = v;
  for (const [k, v] of results) merged[k] = v;

  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  const path = searchProbePath(storeDir);
  const tmp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}

/** Whether a stored probe is recent enough to act on. */
export function probeIsFresh(rec: ProbeRecord, now: number = Date.now()): boolean {
  return now - rec.at <= PROBE_TRUSTED_MS;
}

/**
 * Backends a FRESH probe found unable to search.
 *
 * Only `no_search` and `unverified` count. `refused` means the CLI was never
 * asked (absent, unidentified, or signed out), which the doctor already reports
 * on its own terms, and `failed` means the probe itself did not complete, which
 * is evidence about the probe rather than about the search.
 */
export function probedUnableToSearch(
  probes: ReadonlyMap<string, ProbeRecord>,
  now: number = Date.now(),
): readonly string[] {
  return [...probes]
    .filter(([, r]) => probeIsFresh(r, now) && (r.state === 'no_search' || r.state === 'unverified'))
    .map(([id]) => id);
}
