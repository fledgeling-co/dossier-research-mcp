import type { SupportVerdict } from '../score/containment.js';
import { SUPPORT_LABELS, type PageVerdict, type SupportLabel } from './schema.js';

/**
 * Every translation between one detector's vocabulary and another's.
 *
 * **This file must never import `node:fs` and must never reach a network.**
 *
 * Three arms speak three vocabularies and have to land in one space before they
 * can be compared. The prior art is blunt that the ways of handling an
 * abstention "are not interchangeable preprocessing choices but answer different
 * questions", and prescribes naming the mapping rather than picking one quietly.
 * So every mapping in this slice lives here, is exhaustive over its source enum,
 * and is reported on the result that used it. Nothing else may map a verdict.
 */

/** A detector's answer for one case: a label, or a declared refusal to answer. */
export type Decision<L extends string> =
  | { readonly kind: 'label'; readonly label: L }
  | { readonly kind: 'abstain'; readonly why: string };

export function decided<L extends string>(label: L): Decision<L> {
  return { kind: 'label', label };
}

export function abstained<L extends string>(why: string): Decision<L> {
  return { kind: 'abstain', why };
}

/**
 * What an arm is *able* to say, as opposed to what it happened to say.
 *
 * Containment has no vocabulary for `contradicts` or `partially_supports`, and
 * link checking has none for any support verdict at all. Reporting recall 0 on
 * those without saying so would read as a tuning problem somebody could fix,
 * which is a different and much more flattering claim than "this instrument
 * cannot see that". The result marks every label outside this set
 * `inexpressible`.
 */
export interface ArmCapability<L extends string> {
  readonly arm: string;
  readonly expressible: readonly L[];
  readonly why: string;
}

/**
 * Containment's three answers, in the five-verdict space.
 *
 * `unsupported` becomes `not_addressed` because that is what the verdict means:
 * the page does not contain the numbers, years, identifiers and names the
 * statement asserts. It is not the same claim as "the page is about something
 * else", and it is emphatically not entailment, but among the five it is the one
 * whose definition it matches.
 *
 * `unchecked` abstains. It is the verdict BENCH-03 built the whole slice around
 * refusing to convert into an accusation, and converting it here would undo that
 * at the last step.
 */
export function projectContainment(verdict: SupportVerdict): Decision<SupportLabel> {
  switch (verdict) {
    case 'supported':
      return decided('supports');
    case 'unsupported':
      return decided('not_addressed');
    case 'unchecked':
      return abstained('containment could not decide, so it says nothing');
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

export const CONTAINMENT_CAPABILITY: ArmCapability<SupportLabel> = {
  arm: 'containment',
  expressible: ['supports', 'not_addressed'],
  why: 'token containment asks whether a page contains what a statement asserts. It has no way to tell a weaker version from a contradiction from an absence, and no way to tell an unusable page from an irrelevant one.',
};

/**
 * What link checking can say about support, which is almost nothing.
 *
 * `blocked` is the exception and it is a real one: a paywall, a login gate or a
 * bot block is exactly what `unreadable` names, and the product's own verdict
 * already carries that reading in its note.
 *
 * Everything else abstains, including `live`. A resolving URL makes no claim
 * about whether the page supports anything, and `docs/bench/citation-integrity.md`
 * says so in as many words. Projecting `live` onto `supports` here would score
 * the tool for a claim it does not make; the soundness view below scores the
 * claim a *reader* makes from a green link, which is the honest place for it.
 */
export function projectLinkCheck(verdict: PageVerdict): Decision<SupportLabel> {
  switch (verdict) {
    case 'blocked':
      return decided('unreadable');
    case 'live':
      return abstained('the URL resolved, which says nothing about whether the page supports the claim');
    case 'not_found':
    case 'unreachable':
    case 'unverified':
    case 'invalid_url':
      return abstained(`the page did not resolve (${verdict}), so support was never in question`);
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

export const LINK_CHECK_CAPABILITY: ArmCapability<SupportLabel> = {
  arm: 'link-check',
  expressible: ['unreadable'],
  why: 'dereferencing a URL establishes that it resolves. The only support verdict a status code can reach is `unreadable`, from a paywall or a bot block, and even that misses a login wall served with HTTP 200.',
};

export const JUDGED_CAPABILITY: ArmCapability<SupportLabel> = {
  arm: 'judged',
  expressible: SUPPORT_LABELS,
  why: 'the model is asked for exactly these five and is constrained to them by a Zod enum, so all five are reachable.',
};

export const ALWAYS_SUPPORTS_CAPABILITY: ArmCapability<SupportLabel> = {
  arm: 'always-supports',
  expressible: ['supports'],
  why: 'the degenerate strategy, present so the corpus balance is asserted against a detector rather than argued for in prose.',
};

/**
 * The second view, and why the five-class one is not enough on its own.
 *
 * Scoring containment against a model on five classes is unfair to containment
 * by construction, because three of the five are outside its vocabulary. This
 * collapses to the question a reader actually has, **is this citation sound**,
 * which both arms can answer.
 *
 * `unreadable` leaves the view rather than joining `unsound`. A page nobody
 * could read has not been shown to fail its claim; counting it as a failure
 * would score a wall as a fabrication.
 */
export const SOUNDNESS_LABELS = ['sound', 'unsound'] as const;
export type SoundnessLabel = (typeof SOUNDNESS_LABELS)[number];

/** `null` means the case leaves the binary view entirely. */
export function collapseLabel(label: SupportLabel): SoundnessLabel | null {
  switch (label) {
    case 'supports':
      return 'sound';
    case 'partially_supports':
    case 'contradicts':
    case 'not_addressed':
      return 'unsound';
    case 'unreadable':
      return null;
    default: {
      const exhaustive: never = label;
      return exhaustive;
    }
  }
}

/**
 * A five-class decision, collapsed.
 *
 * `null` where the arm named `unreadable`: it answered the question the binary
 * view does not ask, and forcing that into `sound` or `unsound` would invent an
 * answer it did not give.
 */
export function collapseDecision(decision: Decision<SupportLabel>): Decision<SoundnessLabel> | null {
  if (decision.kind === 'abstain') return abstained(decision.why);
  const collapsed = collapseLabel(decision.label);
  return collapsed === null ? null : decided(collapsed);
}

/**
 * The inference a reader draws from a green link, scored as if it were a verdict.
 *
 * This is **not** what `research_verify_citations` claims. It is what somebody
 * does with its output: the link resolved, so the citation is fine. The tool's
 * own documentation warns against exactly this reading, and the point of putting
 * the mapping here is to turn that warning into a number instead of a sentence.
 * Every result computed through it is labelled `as-read`.
 */
export function projectLinkCheckSoundness(verdict: PageVerdict): Decision<SoundnessLabel> {
  switch (verdict) {
    case 'live':
      return decided('sound');
    case 'blocked':
    case 'not_found':
    case 'unreachable':
    case 'unverified':
    case 'invalid_url':
      return decided('unsound');
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

/**
 * What every number in this slice cannot mean.
 *
 * Carried as data and printed on the report, rather than living only in a doc
 * somebody may not have open. Same rule as BENCH-03's: a result that can be
 * misread is misread, and the caveat has to travel with the number.
 */
export const CANNOT_MEAN: readonly string[] = [
  'A containment `supports` does not mean the page supports the claim. It means the page contains the numbers, years, identifiers and names the claim asserts. Containment is not entailment.',
  'A link-check `live` does not mean the citation is sound. It means the URL resolves, and the soundness view exists to measure what that reading costs.',
  'A per-label precision over a corpus this size is a shape, not a significant difference. The published power analysis puts a discriminating eval at roughly a thousand items.',
  'The labels are one author’s reading of real pages. Every case carries its reasoning so a dispute is settled against argument rather than against authority.',
  'A registry `unchecked` is not a mark against a citation. It is the absence of an answer, and it leaves every denominator.',
];
