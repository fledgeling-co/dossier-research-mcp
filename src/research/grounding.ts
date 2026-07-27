/**
 * A finished report, made available as an input to the next question.
 *
 * `research_export` writes a report to disk and `corpusStores` grounds a run in
 * a File Search store, and until now nothing connected them: to use what you had
 * just learned you exported by hand, uploaded by hand, and remembered the store
 * name. So Dossier's own output was the one kind of evidence it could not easily
 * consume, and every question started from nothing.
 *
 * ## The rule this exists inside, not the feature it exists for
 *
 * A report Dossier produced is **not** independent corroboration of anything in
 * it. A grounded run can launder a claim: report A asserts something weakly
 * supported, run B reads A and repeats it, and now the assertion appears in two
 * reports. That looks like accumulation and is amplification.
 *
 * So a prior report is treated as **the user's own document** under the existing
 * circular-verification rule: valid primary evidence about what was previously
 * concluded, and never independent evidence that the conclusion was right. This
 * module holds the canonical identifier that makes that rule enforceable by pure
 * code — `classifySource` and `assessSupport` are both pure and cannot consult a
 * store, so "is this a prior Dossier report" has to be answerable from the
 * reference itself.
 *
 * Everything here is pure. The filesystem and the upload live in the tool.
 */

/**
 * What a grounding document needs to know about the run it came from.
 *
 * Declared structurally rather than imported from `store/types.js`, and that is
 * load-bearing rather than fussy: `store/types.js` reaches the provider registry
 * and from there the CLI adapters, which read a filesystem. Importing the type
 * would put that whole subtree on this module's import graph, and the benchmark's
 * purity check walks source imports rather than runtime ones. A `RunRecord`
 * satisfies this by construction.
 */
export interface GroundedRun {
  readonly id: string;
  readonly title?: string | undefined;
  readonly question: string;
  readonly provider: string;
  readonly model?: string | undefined;
  readonly tier: string;
  readonly archetype?: string | undefined;
  readonly sourceCount: number;
  readonly estimatedCostUsd?: number | undefined;
  readonly completedAt?: string | undefined;
  readonly updatedAt: string;
  readonly groundedIn?: readonly string[] | undefined;
}

/**
 * The fixed subdirectory a locally-grounded report is written into.
 *
 * Fixed, and not a parameter. `DOSSIER_LOCAL_CORPUS_DIRS` is operator-set and
 * there is deliberately no tool that adds a directory; a write primitive an
 * agent can aim is strictly worse than a read primitive an agent can aim, so the
 * same boundary holds with the same force. One constant location also means an
 * operator can see, audit and delete everything this ever wrote with one
 * command.
 */
export const GROUNDING_SUBDIR = 'dossier-grounding';

/** Run ids as they appear in a path. Checked before a path is ever built. */
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The canonical way to refer to a prior Dossier report.
 *
 * A URI rather than a path, because the same report may sit in a local corpus
 * directory on one machine and in a File Search store on another, and the rule
 * that governs it is the same in both places. `dossier:` is deliberately not an
 * http scheme: `assessSupport` already refuses to count anything that is not
 * resolvable http(s) as a domain, so the identifier fails safe even before the
 * explicit check below.
 */
export function groundingUri(runId: string): string {
  return `dossier://run/${assertGroundableRunId(runId)}`;
}

/** The file name a grounding document is written under, in either destination. */
export function groundingFileName(runId: string): string {
  return `dossier-run-${assertGroundableRunId(runId)}.md`;
}

/**
 * Refuse a run id that could not safely become a path segment.
 *
 * A traversal id would not resolve to a stored run anyway, so this is defence in
 * depth (CP §4 A03). Relying on the lookup would be relying on a property of a
 * different function, which is how a guard quietly stops guarding.
 */
export function assertGroundableRunId(runId: string): string {
  if (!RUN_ID.test(runId)) {
    throw new Error(
      `Invalid run id "${runId.slice(0, 40)}". Expected letters, digits, underscore or hyphen, up to 64 characters.`,
    );
  }
  return runId;
}

/**
 * Is this reference a report Dossier itself produced?
 *
 * Two forms are recognised, because a report is cited two ways: by the canonical
 * URI when a run cites it directly, and by the file name when the reader found
 * it through `corpus_local_search` or a File Search store, where the display
 * name is what comes back.
 */
export function isPriorDossierReport(reference: string): boolean {
  const ref = reference.trim();
  if (!ref) return false;
  if (/^dossier:\/\/run\/[A-Za-z0-9_-]{1,64}$/i.test(ref)) return true;
  // A path, a display name or a bare file name, all of which end the same way.
  const last = ref.split(/[/\\]/).pop() ?? ref;
  return /^dossier-run-[A-Za-z0-9_-]{1,64}\.md$/i.test(last);
}

/** The run id a prior-report reference points at, when it carries one. */
export function priorReportRunId(reference: string): string | null {
  const ref = reference.trim();
  const uri = /^dossier:\/\/run\/([A-Za-z0-9_-]{1,64})$/i.exec(ref);
  if (uri?.[1]) return uri[1];
  const last = ref.split(/[/\\]/).pop() ?? ref;
  const file = /^dossier-run-([A-Za-z0-9_-]{1,64})\.md$/i.exec(last);
  return file?.[1] ?? null;
}

/**
 * The one sentence that has to travel with a prior report wherever it goes.
 *
 * Repeated in the grounding document, in the declaration a grounded report
 * carries, and in the prompt block. Three copies of one string is the point: the
 * rule has to survive being read in only one of the three places.
 */
export const CIRCULARITY_RULE =
  'A Dossier report is the requester’s own document. It is valid primary evidence about what was previously concluded, and it is never independent corroboration that the conclusion was right. Repeating a claim you read here does not corroborate it, and two reports stating one weakly-supported claim is amplification rather than accumulation.';

/**
 * The prompt block a grounded run carries.
 *
 * It names **no** content from the prior reports, deliberately, for two reasons.
 * A locally-grounded report has just been promised never to leave the machine,
 * and putting its text into the next prompt would send it to a provider by the
 * back door. And a report is around sixty thousand tokens, so it does not fit
 * anywhere near a prompt in the first place.
 *
 * Where the prior reports are actually readable — a File Search store on the
 * upload path, `corpus_local_search` on the local one — the reader already has
 * them. What this block adds is the rule for handling what it finds.
 */
export function priorResearchBlock(count: number): string {
  const n = Math.max(1, Math.trunc(count));
  return [
    `This investigation follows ${String(n)} earlier Dossier research run${n === 1 ? '' : 's'} on the subject, whose conclusions are available to the requester and may be attached to this run.`,
    '',
    CIRCULARITY_RULE,
    '',
    'So: carry every claim taken from a prior report with the confidence qualifier and the original source it already had, and cite that original source rather than the report that repeated it. Do not raise a claim’s confidence because a second report now states it. Count support in independent sources, never in reports.',
  ].join('\n');
}

/** What a grounded report declares, in the header of everything that shows it. */
export interface GroundingDeclaration {
  readonly runIds: readonly string[];
}

/**
 * The declaration a run grounded in prior Dossier output carries.
 *
 * Written by code rather than asked of the model. A header the researcher was
 * instructed to produce is a header that is sometimes not there, and the whole
 * point is that a reader can tell accumulated evidence from an echo without
 * having to notice an absence.
 */
export function renderGroundingDeclaration(runIds: readonly string[]): string {
  if (runIds.length === 0) return '';
  const ids = runIds.map((id) => `\`${id}\``).join(', ');
  return [
    '> [!IMPORTANT]',
    `> **Grounded in prior Dossier output.** This run was given ${String(runIds.length)} earlier Dossier report${runIds.length === 1 ? '' : 's'} to work from: ${ids}.`,
    '>',
    `> ${CIRCULARITY_RULE}`,
    '>',
    '> Read the prior reports before treating anything here as newly established. A claim both reports make is one claim, not two.',
  ].join('\n');
}

/** The YAML front-matter lines a grounded artefact carries. */
export function groundingFrontMatter(runIds: readonly string[]): string[] {
  if (runIds.length === 0) return [];
  return [
    `grounded_in: [${runIds.join(', ')}]`,
    'grounded_in_note: "prior Dossier output; primary evidence about what was concluded, never independent corroboration"',
  ];
}

export interface GroundingDocumentArgs {
  readonly run: GroundedRun;
  readonly markdown: string;
}

/**
 * The document that is written to a granted directory, or uploaded to a store.
 *
 * It is the report, led by a header that says what it is. The header matters
 * more than usual here: this file is about to be read back by a research run
 * that has no other way to know it is reading Dossier's own earlier conclusions
 * rather than a source. The provenance block is the same shape `research_export`
 * writes, extended with the identifier the corroboration rule keys on.
 */
export function renderGroundingDocument(args: GroundingDocumentArgs): string {
  const { run } = args;
  const front = [
    '---',
    `title: ${JSON.stringify(run.title ?? run.question.slice(0, 120))}`,
    `run_id: ${run.id}`,
    `dossier_source: ${groundingUri(run.id)}`,
    'dossier_grounding_document: true',
    `question: ${JSON.stringify(run.question)}`,
    `provider: ${run.provider}`,
    ...(run.model ? [`model: ${run.model}`] : []),
    `tier: ${run.tier}`,
    ...(run.archetype ? [`archetype: ${run.archetype}`] : []),
    `sources: ${String(run.sourceCount)}`,
    ...(typeof run.estimatedCostUsd === 'number'
      ? [`estimated_cost_usd: ${run.estimatedCostUsd.toFixed(2)}`]
      : []),
    `completed: ${run.completedAt ?? run.updatedAt}`,
    // A grounding document made from an already-grounded run carries the chain,
    // so a third run can see how far back the echo goes.
    ...groundingFrontMatter(run.groundedIn ?? []),
    '---',
    '',
  ];

  const banner = [
    '> [!IMPORTANT]',
    `> **This is a Dossier research report, not a source.** Cite it as \`${groundingUri(run.id)}\`.`,
    '>',
    `> ${CIRCULARITY_RULE}`,
    '',
  ];

  const chain =
    (run.groundedIn ?? []).length > 0
      ? [renderGroundingDeclaration(run.groundedIn ?? []), '']
      : [];

  return [...front, ...banner, ...chain, args.markdown].join('\n');
}
