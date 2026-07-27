import { selectArchetype, type Archetype } from './archetypes.js';

/**
 * What a question is asking for, in the terms panel routing needs.
 *
 * This sits **on top of** `selectArchetype` rather than beside it. The archetype
 * already answers "what kind of work is this" and is used to shape the prompt;
 * the panel needs a second, additive answer: "which backends can do something
 * here that the others cannot". One question can carry several signals at once,
 * so unlike archetypes, which are deliberately never merged, signals are a set.
 *
 * Two archetypes fold straight into signals because they mean the same thing:
 * `regulatory` is the legal signal and `academic` is the primary-literature
 * signal. `competitive` deliberately does not fold, because it is the classifier's
 * no-match default and folding it would fire on every question that matched
 * nothing. `technical` and `forecasting` do not fold either: neither maps onto a
 * backend that can do something the others cannot.
 */

export const PROFILE_SIGNALS = [
  'enumeration',
  'time-bound',
  'social',
  'primary-literature',
  'named-sites',
  'legal',
  'breadth',
] as const;
export type ProfileSignal = (typeof PROFILE_SIGNALS)[number];

export interface QuestionProfile {
  readonly archetype: Archetype;
  /** Every signal the question carries, in `PROFILE_SIGNALS` order. */
  readonly signals: readonly ProfileSignal[];
  /** Domains named in the question, deduplicated and lower-cased. */
  readonly namedSites: readonly string[];
  /**
   * The question points at pages no search index reaches: a document behind a
   * login, a paywall, a filing. Drives the crawl recommendation and nothing
   * else, so it is not one of the lane-2 signals.
   */
  readonly needsSpecificPages: boolean;
}

/**
 * Keyword patterns, one per signal.
 *
 * Deliberately literal. A classifier that needs a model to run is a classifier
 * that bills to decide whether to bill, and this one runs inside `research_plan`,
 * which is free and must stay free.
 */
const SIGNAL_PATTERNS: Record<Exclude<ProfileSignal, 'named-sites' | 'breadth'>, RegExp> = {
  enumeration:
    /\b(every|all|list|lists|listing|enumerate|complete set|exhaustive|which \w+s|how many|top \d+|\d+ (?:largest|biggest|leading|main))\b/i,
  'time-bound':
    /\b(since|last \d+ (?:days?|weeks?|months?|quarters?|years?)|past \d+ (?:days?|weeks?|months?|quarters?|years?)|latest|current|currently|as of|recent|recently|this (?:year|month|quarter|week)|today|up[- ]to[- ]date|year to date|ytd|(?:19|20)\d{2})\b/i,
  social:
    /\b(what (?:are|do) people (?:saying|think)|sentiment|reaction|reactions|public opinion|social media|twitter|tweets?|on x\b|reddit|hacker news|discourse|backlash|chatter|word of mouth)\b/i,
  'primary-literature':
    /\b(stud(?:y|ies)|papers?|trials?|clinical|peer[- ]?reviewed|literature|meta[- ]analys[ie]s|preprints?|journals?|systematic review|evidence (?:for|base)|randomi[sz]ed|cohort|pubmed|arxiv)\b/i,
  legal:
    /\b(statut\w+|regulat\w+|liabilit\w+|liable|complian\w+|comply|jurisdiction\w*|legislat\w+|legal|lawful|laws?\b|gdpr|hipaa|ccpa|mifid|sarbanes|licens\w+|enforcement|directive|sanctions?|listing rules?|case law|court|tribunal|obligations?|disclosure)\b/i,
};

/** Breadth is measured as well as matched, so it gets its own pattern. */
const BREADTH_WORDS =
  /\b(comprehensive|landscape|overview|state of the|deep[- ]dive|in[- ]depth|end[- ]to[- ]end|holistic|survey of|wide[- ]ranging|across (?:the )?(?:market|industry|sector))\b/i;

/**
 * A question long enough to be several questions.
 *
 * Thirty words is where a single-clause question stops being one, on the
 * sample in `docs/test-plan.md`. It is a heuristic and is stated as one: getting
 * it wrong adds Gemini to a panel that did not need it, and the plan step shows
 * the reader that before anything is spent.
 */
const BREADTH_WORD_COUNT = 30;

/**
 * Domains named in the question.
 *
 * The final label is checked against a list rather than a shape, because
 * "node.js", "vitest.config.ts" and "e.g." all look like domains to a
 * shape-only matcher and none of them is a site anybody wants searched.
 */
const KNOWN_TLDS = new Set([
  'com', 'org', 'net', 'io', 'ai', 'gov', 'edu', 'co', 'uk', 'au', 'ca', 'de', 'fr', 'jp',
  'eu', 'info', 'news', 'dev', 'app', 'health', 'law', 'int', 'mil', 'us', 'nz', 'in', 'cn',
  'ie', 'nl', 'se', 'no', 'ch', 'it', 'es', 'br', 'za', 'sg', 'hk', 'kr',
]);

const DOMAIN_PATTERN = /\b(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,})\b/gi;

/**
 * Pages a search index does not reach.
 *
 * Only ever produces a recommendation for a human to act on. Dossier drives no
 * browser, and this flag cannot cause it to start.
 */
const SPECIFIC_PAGES =
  /\b(behind a (?:login|paywall|sign[- ]?in)|paywalled|subscriber[- ]only|members[- ]only|logged[- ]in|not indexed|un[- ]?indexed|investor portal|data ?room|annual report|10-[kq]\b|filings?)\b/i;

function extractDomains(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(DOMAIN_PATTERN)) {
    const host = match[1]?.toLowerCase();
    if (!host) continue;
    const tld = host.split('.').at(-1);
    if (!tld || !KNOWN_TLDS.has(tld)) continue;
    found.add(host);
  }
  return [...found];
}

/**
 * Read the signals a question carries.
 *
 * Additive by design: a question that is both time-bound and legal returns both,
 * and the panel gets the backend each implies rather than whichever one won a
 * tie-break.
 */
export function profileQuestion(text: string): QuestionProfile {
  const archetype = selectArchetype(text);
  const namedSites = extractDomains(text);
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const questionMarks = (text.match(/\?/g) ?? []).length;

  const signals: ProfileSignal[] = [];
  for (const signal of PROFILE_SIGNALS) {
    if (signal === 'named-sites') {
      if (namedSites.length > 0) signals.push(signal);
      continue;
    }
    if (signal === 'breadth') {
      // Length and sub-questions count as breadth on their own; a question in
      // three parts is a wide question however plainly it is worded.
      if (BREADTH_WORDS.test(text) || words >= BREADTH_WORD_COUNT || questionMarks >= 2) {
        signals.push(signal);
      }
      continue;
    }
    if (SIGNAL_PATTERNS[signal].test(text)) {
      signals.push(signal);
      continue;
    }
    // The archetype folds. `regulatory` IS the legal signal and `academic` IS
    // the primary-literature signal, so a question the keyword pass missed but
    // the classifier caught still gets the right backend.
    if (signal === 'legal' && archetype === 'regulatory') signals.push(signal);
    else if (signal === 'primary-literature' && archetype === 'academic') signals.push(signal);
  }

  return { archetype, signals, namedSites, needsSpecificPages: SPECIFIC_PAGES.test(text) };
}

/** Human-readable signal list for the plan output. */
export function describeSignals(profile: QuestionProfile): string {
  if (profile.signals.length === 0) return 'none detected';
  return profile.signals.join(', ');
}
