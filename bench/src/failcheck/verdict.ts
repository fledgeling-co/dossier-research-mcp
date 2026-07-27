import type { BenchTask } from '../tasks/corpus.js';
import { normalise, valueAppears } from '../verify/match.js';
import { probeFor } from '../verify/verify.js';

/**
 * The pure half of the fail-first check.
 *
 * BENCH-09's fourth admission rule is that a task must be shown to **fail**
 * before it is admitted. A task that is green the day it is written is testing
 * nothing, and a suite of them reports a score that cannot move. The rule is
 * borrowed from Bridgewater's Pocket Analyst teach loop, whose ordering is the
 * load-bearing part: the benchmark is authored expecting to fail, and only then
 * is anything fixed. A check written after the fact is a check validated by its
 * own author.
 *
 * The same value-matching rules as `../verify/match.ts` are used deliberately.
 * If the verifier counts `8.8` as present in a page, this must count it as
 * present in a response, or the corpus would be admitted against one standard
 * and scored against another.
 *
 * What this is **not**: a scorer. It answers one question — does a backend
 * already produce every gold answer — and BENCH-04 owns the real accuracy
 * measure. The overlap is intentional and the asymmetry matters: this check is
 * allowed to be generous, because being generous makes it *harder* to admit a
 * task, which is the safe direction.
 */

/** Enough to see how a claim was phrased, short enough to keep the file readable. */
const EXCERPT_CHARS = 1500;

export type FailVerdict =
  /** Every gold answer already present, and any expected refusal already made. */
  | 'already-passed'
  /** Some of it. Admissible: there is still headroom for a backend to gain on. */
  | 'partial'
  /** None of it. The task discriminates. */
  | 'fails'
  /** The CLI produced nothing, so nothing was established either way. */
  | 'no-response'
  /**
   * This mode cannot establish anything about this task, so it claims nothing.
   *
   * The case is narrow and real: a refusal task carrying no gold facts, probed
   * closed-book. Its correct answer is that a publisher records nothing, and a
   * model with no tools cannot know that — but its honest "I don't know" is
   * written in the same words. Measured against the run this was found in, one
   * response reasoned aloud that `"the record carries no effective date"` was a
   * plausible-sounding answer it refused to assert, and a literal term match
   * scored that as a correct refusal.
   *
   * So the limit is in the *check*, not in the task: literal matching cannot
   * separate asserting an absence from discussing one, which is the same
   * weakness `docs/bench/task-format.md` already declares for rejection cues.
   * Reporting `not-applicable` says what was actually established and pushes
   * the burden onto the search-enabled mode, where a backend that has read the
   * source asserts plainly and the distinction is real.
   */
  | 'not-applicable';

export interface TaskProbe {
  readonly taskId: string;
  readonly category: string;
  readonly factsTotal: number;
  readonly factsPresent: number;
  /** Which gold facts the response already contained, by id. */
  readonly presentFactIds: readonly string[];
  /** Undefined where the task expects no refusal. */
  readonly refusalAcknowledged?: boolean | undefined;
  /**
   * Whether a fabricated term appears at all. Recorded, never scored here: a
   * report saying "there is no version 26.5.1" contains the fabricated string
   * too, which is exactly why the format requires acknowledgement terms and
   * why absence of the term is not evidence of a correct refusal.
   */
  readonly fabricatedTermsMentioned?: boolean | undefined;
  readonly verdict: FailVerdict;
  /** Characters of response the probe saw, for auditing a surprising verdict. */
  readonly responseLength: number;
  /**
   * The opening of the response, kept so a surprising verdict can be
   * adjudicated against what the backend actually said rather than against the
   * author's recollection of it. That is the same rule BENCH-09 applies to gold
   * facts, and a verdict is no more trustworthy than a fact.
   */
  readonly responseExcerpt: string;
}

export interface ProbeOptions {
  /**
   * `closed-book` proves the answer is not already in the weights;
   * `search` proves a real backend does not already pass. They establish
   * different things and only the second can settle a refusal task.
   */
  readonly mode: 'closed-book' | 'search';
}

/** Does the response already contain everything this task is scored on? */
export function probeTask(
  task: BenchTask,
  response: string,
  options: ProbeOptions = { mode: 'search' },
): TaskProbe {
  const trimmed = response.trim();
  const present = task.goldFacts.filter(
    (fact) => valueAppears(trimmed, probeFor(fact)) === 'present',
  );

  const haystack = normalise(trimmed);
  const refusal = task.expectedRefusal;
  const refusalAcknowledged =
    refusal === undefined
      ? undefined
      : refusal.acknowledgementTerms.some((term) => haystack.includes(normalise(term)));
  const fabricatedTermsMentioned =
    refusal === undefined || refusal.kind !== 'false-premise'
      ? undefined
      : refusal.fabricatedTerms.some((term) => haystack.includes(normalise(term)));

  const base = {
    taskId: task.id,
    category: task.category,
    factsTotal: task.goldFacts.length,
    factsPresent: present.length,
    presentFactIds: present.map((f) => f.id),
    refusalAcknowledged,
    fabricatedTermsMentioned,
    responseLength: trimmed.length,
    responseExcerpt: trimmed.slice(0, EXCERPT_CHARS),
  };

  if (trimmed.length === 0) return { ...base, verdict: 'no-response' };

  // See `not-applicable` above: a toolless run cannot distinguish a correct
  // report of absence from an honest confession of ignorance, and pretending
  // otherwise would reject a good task on the strength of a phrase the model
  // used while explicitly declining to assert it.
  if (options.mode === 'closed-book' && refusal !== undefined && task.goldFacts.length === 0) {
    return { ...base, verdict: 'not-applicable' };
  }

  const allFacts = task.goldFacts.length === 0 || present.length === task.goldFacts.length;
  const refusalDone = refusalAcknowledged ?? true;
  if (allFacts && refusalDone) return { ...base, verdict: 'already-passed' };
  if (present.length > 0 || refusalAcknowledged === true) return { ...base, verdict: 'partial' };
  return { ...base, verdict: 'fails' };
}

export interface FailCheckReport {
  /** `closed-book` or `search`; recorded because the two prove different things. */
  readonly mode: string;
  readonly backend: string;
  readonly checkedAt: string;
  readonly probes: readonly TaskProbe[];
  readonly alreadyPassed: number;
  readonly partial: number;
  readonly fails: number;
  readonly noResponse: number;
  readonly notApplicable: number;
}

export function summariseProbes(
  probes: readonly TaskProbe[],
  meta: { readonly mode: string; readonly backend: string; readonly checkedAt: string },
): FailCheckReport {
  const count = (v: FailVerdict): number => probes.filter((p) => p.verdict === v).length;
  return {
    ...meta,
    probes,
    alreadyPassed: count('already-passed'),
    partial: count('partial'),
    fails: count('fails'),
    noResponse: count('no-response'),
    notApplicable: count('not-applicable'),
  };
}
