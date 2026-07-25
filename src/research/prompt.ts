import {
  ARCHETYPE_OVERRIDES,
  selectArchetype,
  type Archetype,
} from './archetypes.js';

/**
 * The prompt architect — the executable form of the bundled
 * `deep-research-prompt-creator` skill (`skills/deep-research-prompt-creator/`).
 *
 * Two paths in, one path out:
 *
 *  1. A caller passes a bare question → we build the full pseudo-XML scaffold
 *     here, picking one archetype and applying only its overrides.
 *  2. A caller (or an agent that ran the skill) passes a prompt that already
 *     carries the scaffold → we detect it and send it **verbatim**. Re-wrapping
 *     an engineered prompt is the worst outcome available: two `<role>` blocks
 *     and two conflicting `<output_format>` sections is precisely the
 *     over-specification failure the skill exists to avoid.
 *
 * Pure, no I/O, so the whole scaffold is unit-testable.
 */

/**
 * Optional fields carry an explicit `| undefined` because they arrive from a
 * Zod-parsed tool argument under `exactOptionalPropertyTypes`: an absent key
 * and an explicitly-undefined one mean the same thing to this builder.
 */
export interface ResearchScope {
  /** Jurisdiction or geography — load-bearing for regulatory and market work. */
  readonly jurisdiction?: string | undefined;
  /** Time window and forward outlook. */
  readonly timeHorizon?: string | undefined;
  /** What the caller will DO with the findings — drives the analysis lens. */
  readonly decisionContext?: string | undefined;
  /** Extra analytical frames to apply on top of the archetype's. */
  readonly analysisLenses?: readonly string[] | undefined;
  /** Explicit out-of-scope items. */
  readonly exclude?: readonly string[] | undefined;
}

export interface BuildPromptArgs {
  readonly question: string;
  readonly archetype?: Archetype;
  readonly scope?: ResearchScope;
  /**
   * A private corpus is attached. Adds the hierarchy-of-truth block and the
   * contradictions requirement, both placed INSIDE the scaffold rather than
   * appended after it (see `corpusGrounding` handling below for why).
   */
  readonly corpusGrounding?: boolean;
}

export interface BuiltPrompt {
  readonly prompt: string;
  readonly archetype: Archetype;
  /** True when the caller's text was already scaffolded and passed through. */
  readonly preEngineered: boolean;
}

/**
 * The private-corpus block.
 *
 * Placement is load-bearing and was got wrong once, live: appending this after
 * the closing `<core_directive>` put it in the weakest position in the prompt
 * AND destroyed the anti-drift re-anchor, which only works because it is the
 * last thing the model reads. A run with an indexed corpus, the tool attached
 * and this text present produced a 12,660-token report with zero references to
 * the corpus. It now sits before the re-anchor, and the contradictions
 * requirement is additionally folded into `<output_format>`, where output
 * requirements actually live.
 */
export const CORPUS_GROUNDING_BLOCK = `A private document corpus is attached via file search. Search it alongside the public web, and treat searching it as required rather than optional.

Hierarchy of truth: where the attached internal documents conflict with public web sources on a matter of internal fact (our own numbers, decisions, product behaviour, commitments), the internal documents are authoritative. Public sources remain authoritative for external facts.`;

export const CORPUS_OUTPUT_REQUIREMENT =
  '## Contradictions with the attached corpus — every material point where the public evidence contradicts, supersedes, or postdates the internal documents. For each: the internal claim, the external evidence with its citation, and which one is current. If there are genuinely none, write "No contradictions found" under the heading rather than omitting it.';

/**
 * Markers of an already-engineered brief. `<core_directive>` is the strongest
 * signal — it is the skill's anti-drift anchor and appears in no natural
 * question — but any two structural tags together are conclusive enough.
 */
const SCAFFOLD_TAGS = [
  'core_directive',
  'research_questions',
  'source_discipline',
  'epistemic_bounding',
  'citation_protocol',
  'output_format',
  'analysis_lens',
  'scope_and_boundaries',
  'depth_requirements',
] as const;

/** Detect a prompt that already carries the Deep Research scaffold. */
export function isPreEngineered(text: string): boolean {
  if (/<core_directive>/i.test(text)) return true;
  const hits = SCAFFOLD_TAGS.filter((tag) => new RegExp(`<${tag}>`, 'i').test(text));
  return hits.length >= 2;
}

/**
 * Pull the core directive out of an engineered prompt, for labelling and
 * fingerprinting. Falls back to the first non-empty line.
 */
export function extractCoreDirective(text: string): string {
  const match = /<core_directive>\s*([\s\S]*?)\s*<\/core_directive>/i.exec(text);
  if (match?.[1]) return match[1].trim().replace(/\s+/g, ' ').slice(0, 500);
  const firstLine = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('<'));
  return (firstLine ?? text).replace(/\s+/g, ' ').slice(0, 500);
}

function block(tag: string, body: string): string {
  return `<${tag}>\n${body.trim()}\n</${tag}>`;
}

function list(items: readonly string[]): string {
  return items.map((i) => `- ${i}`).join('\n');
}

/**
 * Build the Deep Research prompt.
 *
 * Structure is load-bearing: Gemini's attention uses the pseudo-XML tags to
 * separate instruction from context, and they survive the plan-generation
 * compression better than markdown headings. The `<core_directive>` appears
 * exactly twice — once near the top and once verbatim at the very end, which
 * re-anchors synthesis after up to an hour of recursive search.
 */
export function buildPrompt(args: BuildPromptArgs): BuiltPrompt {
  const raw = args.question.trim();

  if (isPreEngineered(raw)) {
    return {
      prompt: raw,
      archetype: args.archetype ?? selectArchetype(raw),
      preEngineered: true,
    };
  }

  const archetype = args.archetype ?? selectArchetype(raw);
  const o = ARCHETYPE_OVERRIDES[archetype];
  const scope = args.scope ?? {};

  const directive = `Answer this decisively: ${raw.replace(/\s+/g, ' ')}`;
  const decision = scope.decisionContext?.trim() || 'inform the requester’s decision';
  const timeHorizon =
    scope.timeHorizon?.trim() ||
    'Most recent authoritative data, with any relevant forward outlook.';
  const jurisdiction = scope.jurisdiction?.trim();

  const excludes = [
    'Tangential background material, SEO aggregator content, and pre-scope introductory explainers.',
    ...(scope.exclude ?? []),
  ];

  const lenses = [...o.lens, ...(scope.analysisLenses ?? [])];
  const corpus = args.corpusGrounding === true;

  const sections = [
    block(
      'role',
      `You are a senior research analyst ${o.role}. Your output will directly ${decision}.`,
    ),
    block(
      'context',
      `This investigation supports a concrete decision. Keep this context tight — context bloat degrades long-running agentic output; domain knowledge belongs in the analysis lens below.${
        jurisdiction ? ` Jurisdiction and geography: ${jurisdiction}.` : ''
      }`,
    ),
    block('core_directive', directive),
    block(
      'research_questions',
      [
        'Primary:',
        `1. ${directive}`,
        '',
        'Secondary:',
        '2. What is the current state, and what is the strongest supporting evidence for it?',
        '3. What are the contrasting viewpoints or competing evidence?',
        '4. What changed recently, and what is the trajectory?',
      ].join('\n'),
    ),
    block(
      'scope_and_boundaries',
      [
        block(
          'include',
          list([
            'Entities, technologies, geographies, segments, and time windows directly relevant to the core directive.',
          ]),
        ),
        block('exclude', list(excludes)),
        block('time_horizon', timeHorizon),
      ].join('\n'),
    ),
    block(
      'source_discipline',
      [
        block(
          'prioritise',
          list([
            'Primary and authoritative sources: official documentation, peer-reviewed literature, regulators, government databases, published benchmarks, raw datasets, court filings, filed financials.',
            ...o.prioritise,
          ]),
        ),
        block(
          'deprioritise',
          list([
            'Aggregator sites, SEO-optimised listicles, marketing blogs, vendor comparison pages, and content farms. Do not rely on these as primary evidence; if cited at all, label them `[SECONDARY: promotional]` and corroborate from a primary source.',
            ...o.deprioritise,
          ]),
        ),
        block(
          'criteria_match_validator',
          'For each source integrated into the synthesis, briefly justify why it met the source-discipline criteria. Discard sources that cannot be justified rather than including them with a caveat.',
        ),
      ].join('\n'),
    ),
    block(
      'depth_requirements',
      list([
        'Factual findings with quantitative data where available (numbers, dates, specific named entities).',
        'Contrasting viewpoints or competing evidence wherever it exists.',
        'Named sources (author or organisation, publication date, URL).',
        'A confidence qualifier on every non-trivial claim: High, Medium, or Low.',
        ...o.depth,
      ]),
    ),
    block(
      'analysis_lens',
      `Apply these analytical frames where relevant — they tell you how to think about the findings, not only what to find:\n${list(lenses)}`,
    ),
    block(
      'epistemic_bounding',
      `${[
        'When data is unavailable, unreliable, or contested, use these tags inline. Do not estimate, extrapolate, or paper over gaps:',
        list([
          '`<MISSING_DATA>[what was sought, what was unavailable, what would be needed]</MISSING_DATA>`',
          '`<INSUFFICIENT_EVIDENCE>[claim that could not be corroborated, and why]</INSUFFICIENT_EVIDENCE>`',
          '`<CONFLICTING_EVIDENCE>[the positions, their sources, the nature of the disagreement]</CONFLICTING_EVIDENCE>`',
          '`<CONFIDENCE:LOW>[the claim]</CONFIDENCE:LOW>` for weakly-supported but load-bearing estimates',
          '`<INFERENCE>[claim derived by reasoning; show the chain]</INFERENCE>`',
        ]),
        'Do not present extrapolated or synthesised numbers as empirical findings.',
      ].join('\n')}`,
    ),
    block(
      'citation_protocol',
      'Append an inline `<cite url="...">` to every quantitative claim, every attributed statement, and every regulatory or legal reference, at the point of the claim itself. Do not aggregate citations at the end of a paragraph or into a bibliography — that is where source attribution is lost. If a URL is not verifiable at synthesis time, use `<cite url="UNVERIFIED" note="[what was sought]">` rather than omitting or inventing one.',
    ),
    block(
      'output_format',
      `Structure the report exactly as follows:\n${list([
        '## Executive Summary — 5-8 bullets, each led by a `(High Confidence)` / `(Medium Confidence)` / `(Low Confidence)` qualifier; usable as a standalone briefing.',
        '## Detailed Findings — one section per research question, using the question as the heading; narrative prose with inline citations, tables for comparative data.',
        '## Evidence Table — | Claim | Primary Source | Publication Date | Evidence Type | URL |, mapping every major claim to a verifiable source.',
        '## Knowledge Gaps — what could not be answered, categorised by cause.',
        '## Recommended Next Steps — 3-5 follow-up investigations, each with a stated rationale.',
        ...(corpus ? [CORPUS_OUTPUT_REQUIREMENT] : []),
        ...o.output,
      ])}`,
    ),
    block(
      'constraints',
      list([
        'Do not fabricate citations, URLs, authors, or dates; use the unverified citation form when a source cannot be verified.',
        'Where data conflicts, present both positions with their evidence — do not silently pick one.',
        'Keep prose dense but readable; avoid filler phrases.',
        'Cite inline at the point of the claim, never aggregated at the end.',
      ]),
    ),
    // Corpus grounding sits HERE, before the re-anchor, never after it.
    ...(corpus ? [block('corpus_grounding', CORPUS_GROUNDING_BLOCK)] : []),
    // The anti-drift re-anchor: the directive repeated verbatim at the very end.
    // Nothing may follow this block.
    block('core_directive', directive),
  ];

  return { prompt: sections.join('\n\n'), archetype, preEngineered: false };
}

/**
 * The Operator Notes the skill appends after the prompt. Returned alongside a
 * plan so a caller gets the wrap-around workflow, not just the text — the
 * skill's own claim is that the workflow matters as much as the prompt.
 */
export function operatorNotes(args: {
  readonly archetype: Archetype;
  readonly tier: 'fast' | 'max';
  readonly collaborativePlanning: boolean;
  readonly hasCorpus: boolean;
  readonly questionLength: number;
}): string[] {
  const notes: string[] = [];

  if (args.collaborativePlanning) {
    notes.push(
      'Plan Review is ON. When `research_plan` returns Gemini’s proposed plan, edit it before approving — prune tangential branches, inject missing angles, narrow broad definitions. This is the single highest-leverage intervention available on a Deep Research run; zero-shot autonomous execution is the wrong default for anything decision-critical.',
    );
  } else {
    notes.push(
      'Plan Review is OFF — the run executes autonomously. For a decision-critical question, re-run with `collaborativePlanning: true` and edit the plan before approving.',
    );
  }

  notes.push(
    'Pre-scoping: if the domain vocabulary is uncertain, spend one cheap single-shot model call identifying the correct terminology, leading experts, and primary frameworks first, then feed those terms in. It stops the run burning its search loop on introductory material.',
  );

  if (args.questionLength > 600 || args.tier === 'max') {
    notes.push(
      'Decomposition: if the scope spans two archetypes (say market **and** regulatory), split it into 3-4 narrowly-scoped runs sharing the same role and context but varying the core directive, then synthesise in a final non-research pass. A single monolithic run drifts in format and rots in context past a certain size.',
    );
  }

  notes.push(
    'Adversarial audit: run `research_verify_citations` when it completes, then hand the report to a different strong model prompted as a red-team analyst — verify citations, flag unsupported claims, stress-test the confidence qualifiers. Secondary-model validation catches failure modes the producing model cannot see in itself.',
  );

  notes.push(
    'Cross-lingual retrieval: if the topic touches international markets, geopolitics, or non-English primary sources, add "Formulate parallel search queries in [languages] to retrieve regional primary sources, then translate and integrate them into the English synthesis." An English-default search leaves blind spots.',
  );

  if (args.hasCorpus) {
    notes.push(
      'Hierarchy of truth: your corpus is attached. State explicitly in the prompt that when the internal documents conflict with public web sources, the internal documents are authoritative — otherwise high-fidelity internal data gets silently overwritten by lower-fidelity public data.',
    );
  }

  if (args.archetype === 'regulatory') {
    notes.push(
      'This is regulatory mapping, not legal advice. Confirm every enacted obligation with qualified counsel in each jurisdiction before acting on it.',
    );
  }

  return notes;
}
