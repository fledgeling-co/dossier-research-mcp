import type { BenchTask } from '../tasks/corpus.js';
import type { GoldFact } from '../tasks/schema.js';
import {
  dateForms,
  extractText,
  numberForms,
  quoteAppears,
  valueAppears,
  type Presence,
  type ValueProbe,
} from './match.js';

/**
 * Walk a corpus and prove, source by source, that every gold fact is really
 * where its author said it was.
 *
 * Pure over an injected fetcher, for the same reason `corpus.ts` is pure over
 * injected file contents: the rules are the part worth testing, and a rule that
 * can only be exercised with a network is a rule nobody exercises. `cli.ts`
 * supplies the real fetcher.
 */

/** One fetched page or API response, however it turned out. */
export interface FetchedSource {
  readonly url: string;
  readonly status: number;
  readonly ok: boolean;
  readonly body: string;
  readonly contentType: string;
  /**
   * True when the reader stopped at the byte cap before the response ended.
   *
   * Load-bearing, not diagnostic. `safeFetch` truncates silently, so without
   * this flag a fact sitting past the cap in a fifteen-megabyte registry
   * document reads exactly like a fact that was never there — and the verifier
   * would report a true gold fact as fabricated, which is the single worst
   * answer it can give.
   */
  readonly truncated: boolean;
  /** Set when the fetch never produced a response at all. */
  readonly error?: string | undefined;
}

export type SourceFetcher = (url: string) => Promise<FetchedSource>;

/**
 * What a source ref is attached to.
 *
 * Recorded because the roles are not checked identically and a reader of the
 * report needs to know which check ran. A gold fact carries a value to look for;
 * a dissenting source carries only a URL, so all that can be established about
 * it is that it is reachable, and claiming more would be dishonest.
 */
export type SourceRole = 'goldFact' | 'conflictingValue' | 'fringeClaim' | 'knownDissent';

export type FactVerdict =
  | 'proven'
  | 'quote-absent'
  | 'value-absent'
  | 'both-absent'
  | 'source-truncated'
  | 'unreachable';

export interface FactCheck {
  readonly taskId: string;
  readonly file: string;
  readonly role: SourceRole;
  /** The fact's stable id, or the dissenting source's distinguishing term. */
  readonly factId: string;
  readonly label?: string | undefined;
  readonly url: string;
  readonly status: number;
  /** `not-checked` where the author recorded no quote, which is permitted. */
  readonly quote: Presence | 'not-checked';
  readonly value: Presence | 'not-checked';
  readonly verdict: FactVerdict;
  readonly note?: string | undefined;
}

export interface VerificationReport {
  /** The date the run happened, `YYYY-MM-DD`, supplied rather than read. */
  readonly checkedAt: string;
  readonly taskCount: number;
  readonly checks: readonly FactCheck[];
  readonly proven: number;
  readonly unproven: number;
  readonly unreachable: number;
}

/** The strings that would express a gold fact's value in a document. */
export function probeFor(fact: GoldFact): ValueProbe {
  switch (fact.kind) {
    case 'number':
      return { forms: numberForms(fact.value) };
    case 'date':
      return { forms: dateForms(fact.value) };
    case 'name':
    case 'identifier':
      return { forms: [fact.value, ...fact.aliases] };
  }
}

function verdictFor(quote: Presence | 'not-checked', value: Presence | 'not-checked'): FactVerdict {
  const quoteBad = quote === 'absent';
  const valueBad = value === 'absent';
  if (quoteBad && valueBad) return 'both-absent';
  if (quoteBad) return 'quote-absent';
  if (valueBad) return 'value-absent';
  return 'proven';
}

interface Target {
  readonly role: SourceRole;
  readonly factId: string;
  readonly label?: string | undefined;
  readonly url: string;
  readonly quote?: string | undefined;
  readonly probe?: ValueProbe | undefined;
}

/** Everything in one task that cites a source, flattened into checkable targets. */
export function targetsFor(task: BenchTask): Target[] {
  const targets: Target[] = [];
  for (const fact of task.goldFacts) {
    targets.push({
      role: 'goldFact',
      factId: fact.id,
      label: fact.label,
      url: fact.source.url,
      quote: fact.source.quote,
      probe: probeFor(fact),
    });
  }
  for (const figure of task.conflictingFigures) {
    for (const value of figure.values) {
      targets.push({
        role: 'conflictingValue',
        factId: value.id,
        label: value.label ?? figure.quantity,
        url: value.source.url,
        quote: value.source.quote,
        probe: { forms: numberForms(value.value) },
      });
    }
  }
  for (const claim of task.fringeClaims) {
    targets.push({
      role: 'fringeClaim',
      factId: claim.distinguishingTerm,
      label: claim.claim.slice(0, 80),
      url: claim.source.url,
      quote: claim.source.quote,
      probe: { forms: [claim.distinguishingTerm] },
    });
  }
  for (const dissent of task.knownDissent) {
    // No value and no quote: the format records only a URL and a term the
    // dissenting source uses, and the term is a property of the *report* being
    // scored rather than of this page. Reachability is all that can honestly be
    // established, so that is all that is claimed.
    targets.push({ role: 'knownDissent', factId: dissent.distinguishingTerm, url: dissent.url });
  }
  return targets;
}

export interface VerifyOptions {
  readonly fetcher: SourceFetcher;
  /** `YYYY-MM-DD`, stamped on the report. Never read from the clock. */
  readonly checkedAt: string;
  /** Called after each check, so a long run can print as it goes. */
  readonly onCheck?: (check: FactCheck) => void;
}

/**
 * Verify every source in every task.
 *
 * Responses are cached by URL for the length of the run. A corpus deliberately
 * cites one source for several facts of the same task, and re-fetching it per
 * fact would multiply the load on publishers who are doing us a favour by
 * answering at all.
 */
export async function verifyCorpus(
  tasks: readonly BenchTask[],
  options: VerifyOptions,
): Promise<VerificationReport> {
  const cache = new Map<string, FetchedSource>();
  const checks: FactCheck[] = [];

  for (const task of tasks) {
    for (const target of targetsFor(task)) {
      let fetched = cache.get(target.url);
      if (!fetched) {
        fetched = await options.fetcher(target.url);
        cache.set(target.url, fetched);
      }

      let check: FactCheck;
      if (!fetched.ok) {
        check = {
          taskId: task.id,
          file: task.file,
          role: target.role,
          factId: target.factId,
          label: target.label,
          url: target.url,
          status: fetched.status,
          quote: 'not-checked',
          value: 'not-checked',
          verdict: 'unreachable',
          note: fetched.error ?? `HTTP ${String(fetched.status)}`,
        };
      } else {
        const text = extractText(fetched.body, fetched.contentType);
        const quote: Presence | 'not-checked' =
          target.quote === undefined ? 'not-checked' : quoteAppears(text, target.quote);
        const value: Presence | 'not-checked' =
          target.probe === undefined ? 'not-checked' : valueAppears(text, target.probe);
        const verdict = verdictFor(quote, value);
        check = {
          taskId: task.id,
          file: task.file,
          role: target.role,
          factId: target.factId,
          label: target.label,
          url: target.url,
          status: fetched.status,
          quote,
          value,
          // A miss against a body we stopped reading early proves nothing, so
          // it is reported as what it is. A *hit* against a truncated body is
          // still a hit: finding the string is finding it.
          verdict: verdict === 'proven' || !fetched.truncated ? verdict : 'source-truncated',
          note: fetched.truncated ? 'response was truncated at the byte cap' : undefined,
        };
      }

      checks.push(check);
      options.onCheck?.(check);
    }
  }

  const unreachable = checks.filter((c) => c.verdict === 'unreachable').length;
  const proven = checks.filter((c) => c.verdict === 'proven').length;
  return {
    checkedAt: options.checkedAt,
    taskCount: tasks.length,
    checks,
    proven,
    unproven: checks.length - proven,
    unreachable,
  };
}
