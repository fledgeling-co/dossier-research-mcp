import {
  armGap,
  cell,
  scoreArm,
  type ArmGap,
  type ArmScore,
  type Judgement,
} from './confusion.js';
import type { DetectorCorpus } from './corpus.js';
import {
  alwaysSupportsJudgements,
  containmentJudgements,
  judgedJudgements,
  linkCheckJudgements,
  linkCheckSoundnessJudgements,
  registryJudgements,
  toSoundness,
} from './arms.js';
import { REGISTRY_LABELS, SUPPORT_LABELS, type RegistryLabel, type SupportLabel } from './schema.js';
import {
  ALWAYS_SUPPORTS_CAPABILITY,
  CANNOT_MEAN,
  CONTAINMENT_CAPABILITY,
  JUDGED_CAPABILITY,
  LINK_CHECK_CAPABILITY,
  SOUNDNESS_LABELS,
  type ArmCapability,
  type SoundnessLabel,
} from './verdicts.js';

/**
 * The whole result, assembled and rendered.
 *
 * **This file must never import `node:fs` and must never reach a network.**
 *
 * Two things ride on every result and neither is decoration. The **headline
 * counts** are the numbers the brief actually asks for, pulled out of the matrix
 * by name because aggregate accuracy hides them: `not_addressed` scored as
 * `supports` is the failure this whole slice exists to price. And
 * **`CANNOT_MEAN`** travels with the numbers rather than living in a document
 * somebody may not have open, on BENCH-03's rule that a result which can be
 * misread will be.
 */

const SOUNDNESS_CAPABILITY = (arm: string, why: string): ArmCapability<SoundnessLabel> => ({
  arm,
  expressible: SOUNDNESS_LABELS,
  why,
});

const REGISTRY_CAPABILITY: ArmCapability<RegistryLabel> = {
  arm: 'registry',
  expressible: REGISTRY_LABELS,
  why: 'the lookup loop reaches all four, and `unchecked` is one of them rather than an abstention: a registry that could not be reached has given a real answer about what is known, which is nothing.',
};

/** The numbers a reader is actually after, named rather than left in the matrix. */
export interface HeadlineCounts {
  /**
   * The failure the brief names. A page about the right topic that does not
   * contain the claim, scored as though it did.
   */
  readonly notAddressedScoredSupports: number;
  /** A contradiction scored as support, which is the same failure pointing the other way. */
  readonly contradictsScoredSupports: number;
  /** An unusable page scored as though it said something. */
  readonly unreadableScoredSupports: number;
  /**
   * Citations whose URL resolves perfectly and whose page does not support the
   * claim attached to it. What link checking cannot see, as a count.
   */
  readonly liveButUnsound: number;
  /** Of those, the ones a reader would have to open the page to catch. */
  readonly liveButUnsoundShare: number | null;
}

export interface SupportReport {
  readonly cases: number;
  readonly labelCounts: readonly { readonly label: SupportLabel; readonly count: number }[];
  readonly arms: readonly ArmScore<SupportLabel>[];
  readonly soundness: readonly ArmScore<SoundnessLabel>[];
  readonly containmentVersusJudged: ArmGap<SupportLabel>;
  readonly headline: HeadlineCounts;
  readonly judgedModel: string | null;
  readonly cannotMean: readonly string[];
}

export interface RegistryReport {
  readonly cases: number;
  readonly labelCounts: readonly { readonly label: RegistryLabel; readonly count: number }[];
  readonly arm: ArmScore<RegistryLabel>;
  /** Cases whose true label is `unchecked` that the detector called `absent`. */
  readonly uncheckedScoredAbsent: number;
}

export interface DetectorReport {
  readonly support: SupportReport;
  readonly registry: RegistryReport;
}

function counts<L extends string>(
  labels: readonly L[],
  cases: readonly { readonly label: L }[],
): { label: L; count: number }[] {
  return labels.map((label) => ({ label, count: cases.filter((c) => c.label === label).length }));
}

/** Score every support arm over the corpus. Pure, synchronous, no model anywhere. */
export function scoreSupport(corpus: DetectorCorpus): SupportReport {
  const cases = corpus.support;
  const containment = containmentJudgements(cases);
  const judged = judgedJudgements(cases, corpus.judged);
  const linkCheck = linkCheckJudgements(cases);
  const degenerate = alwaysSupportsJudgements(cases);

  const arms: ArmScore<SupportLabel>[] = [
    scoreArm({ labels: SUPPORT_LABELS, capability: CONTAINMENT_CAPABILITY, judgements: containment }),
    scoreArm({ labels: SUPPORT_LABELS, capability: JUDGED_CAPABILITY, judgements: judged }),
    scoreArm({ labels: SUPPORT_LABELS, capability: LINK_CHECK_CAPABILITY, judgements: linkCheck }),
    scoreArm({
      labels: SUPPORT_LABELS,
      capability: ALWAYS_SUPPORTS_CAPABILITY,
      judgements: degenerate,
    }),
  ];

  const soundness: ArmScore<SoundnessLabel>[] = [
    scoreArm({
      labels: SOUNDNESS_LABELS,
      capability: SOUNDNESS_CAPABILITY(
        'containment',
        'the binary view is the fair comparison for a three-answer instrument: both sides of it are inside what containment is for.',
      ),
      judgements: toSoundness(containment),
    }),
    scoreArm({
      labels: SOUNDNESS_LABELS,
      capability: SOUNDNESS_CAPABILITY('judged', 'the five verdicts collapse onto both sides.'),
      judgements: toSoundness(judged),
    }),
    scoreArm({
      labels: SOUNDNESS_LABELS,
      capability: SOUNDNESS_CAPABILITY(
        'link-check-as-read',
        'scored on the inference a reader draws from a green link, which is not what the tool claims. The mapping is declared in `verdicts.ts` and the arm is named `as-read` everywhere it appears.',
      ),
      judgements: linkCheckSoundnessJudgements(cases),
    }),
  ];

  const containmentArm = arms[0];
  const judgedArm = arms[1];
  if (containmentArm === undefined || judgedArm === undefined) {
    throw new Error('the support arms were not assembled');
  }

  const liveButUnsound = cases.filter(
    (c) => c.page.verdict === 'live' && c.label !== 'supports',
  ).length;
  const liveCases = cases.filter((c) => c.page.verdict === 'live').length;

  return {
    cases: cases.length,
    labelCounts: counts(SUPPORT_LABELS, cases),
    arms,
    soundness,
    containmentVersusJudged: armGap(
      { arm: 'containment', judgements: containment },
      { arm: 'judged', judgements: judged },
    ),
    headline: {
      notAddressedScoredSupports: cell(judgedArm.matrix, 'not_addressed', 'supports'),
      contradictsScoredSupports: cell(judgedArm.matrix, 'contradicts', 'supports'),
      unreadableScoredSupports: cell(judgedArm.matrix, 'unreadable', 'supports'),
      liveButUnsound,
      liveButUnsoundShare: liveCases === 0 ? null : liveButUnsound / liveCases,
    },
    judgedModel: corpus.judged?.model ?? null,
    cannotMean: CANNOT_MEAN,
  };
}

/** Score the registry family. Async only because the production loop is. */
export async function scoreRegistry(corpus: DetectorCorpus): Promise<RegistryReport> {
  const judgements: readonly Judgement<RegistryLabel>[] = await registryJudgements(corpus.registry);
  const arm = scoreArm({
    labels: REGISTRY_LABELS,
    capability: REGISTRY_CAPABILITY,
    judgements,
  });
  return {
    cases: corpus.registry.length,
    labelCounts: counts(REGISTRY_LABELS, corpus.registry),
    arm,
    uncheckedScoredAbsent: cell(arm.matrix, 'unchecked', 'absent'),
  };
}

export async function scoreDetector(corpus: DetectorCorpus): Promise<DetectorReport> {
  return { support: scoreSupport(corpus), registry: await scoreRegistry(corpus) };
}

function pct(value: number | null): string {
  return value === null ? '  n/a' : `${(value * 100).toFixed(1)}%`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function renderArm<L extends string>(score: ArmScore<L>): string[] {
  const lines: string[] = [];
  lines.push('');
  lines.push(`## ${score.arm}`);
  lines.push('');
  lines.push(`  ${score.capability.why}`);
  lines.push('');
  lines.push(
    `  cases ${String(score.total)} · answered ${String(score.committed)} · declined ${String(score.abstentions)} · coverage ${pct(score.coverage)}`,
  );
  lines.push(
    `  accuracy over answered ${pct(score.accuracyOverCommitted)} · over every case ${pct(score.accuracyOverAll)}`,
  );
  lines.push(
    `  macro-F1 whole vocabulary ${score.macroF1.toFixed(3)} · over what it can express ${score.macroF1Expressible === null ? 'n/a' : score.macroF1Expressible.toFixed(3)}`,
  );
  lines.push('');

  const width = Math.max(...score.matrix.labels.map((l) => l.length), 12);
  const header = ['true \\ said'.padEnd(width), ...score.matrix.columns.map((c) => pad(c, 12))];
  lines.push(`  ${header.join(' ')}`);
  for (const row of score.matrix.rows) {
    const cells = row.cells.map((c) => pad(String(c.count), 12));
    lines.push(`  ${pad(row.trueLabel, width)} ${cells.join(' ')}`);
  }
  lines.push('');
  lines.push(
    `  ${pad('label', width)} ${['support', 'said', 'prec', 'rec(ans)', 'rec(all)', 'F1(all)', 'declined'].map((h) => pad(h, 10)).join(' ')}`,
  );
  for (const s of score.perLabel) {
    const row = [
      String(s.support),
      String(s.predicted),
      pct(s.precision),
      pct(s.recallCommitted),
      pct(s.recallAll),
      s.f1All === null ? '  n/a' : s.f1All.toFixed(3),
      String(s.abstentions),
    ].map((v) => pad(v, 10));
    lines.push(
      `  ${pad(s.label, width)} ${row.join(' ')}${s.expressible ? '' : '  (inexpressible by this arm)'}`,
    );
  }
  return lines;
}

/** The whole report as text. What the CLI prints and what a reader is handed. */
export function renderReport(report: DetectorReport): string {
  const lines: string[] = [];
  lines.push('# Does Dossier’s own checking actually work');
  lines.push('');
  lines.push(
    'A detector eval. The corpus is labelled, frozen and offline, and the score is a confusion matrix rather than a rate. Every number below is computed by code from labels fixed before any detector ran.',
  );

  lines.push('');
  lines.push('# The support family');
  lines.push('');
  lines.push(
    `  ${String(report.support.cases)} cases · ${report.support.labelCounts.map((c) => `${c.label} ${String(c.count)}`).join(' · ')}`,
  );
  lines.push(
    `  judged pass: ${report.support.judgedModel ?? 'none has been run, so that arm declines every case'}`,
  );
  for (const arm of report.support.arms) lines.push(...renderArm(arm));

  lines.push('');
  lines.push('# The soundness view');
  lines.push('');
  lines.push(
    '  Collapsed to `is this citation sound`, because scoring a three-answer instrument on five classes is unfair to it by construction. `unreadable` cases leave the view: a page nobody could read has not been shown to fail its claim.',
  );
  for (const arm of report.support.soundness) lines.push(...renderArm(arm));

  lines.push('');
  lines.push('# Containment against the judged mode, paired');
  lines.push('');
  const gap = report.support.containmentVersusJudged;
  lines.push(
    `  both right ${String(gap.bothRight)} · only containment ${String(gap.onlyARight)} · only judged ${String(gap.onlyBRight)} · both wrong ${String(gap.bothWrong)}`,
  );
  lines.push(
    `  containment declined where judged answered: ${String(gap.aAbstainedBAnswered)} · the reverse: ${String(gap.bAbstainedAAnswered)}`,
  );
  if (gap.cases.length > 0) {
    lines.push('');
    lines.push('  where they differ:');
    for (const c of gap.cases) {
      lines.push(`    ${c.caseId}  truth=${c.trueLabel}  containment=${c.a}  judged=${c.b}`);
    }
  }

  lines.push('');
  lines.push('# The counts aggregate accuracy hides');
  lines.push('');
  const h = report.support.headline;
  lines.push(`  not_addressed scored as supports (judged arm): ${String(h.notAddressedScoredSupports)}`);
  lines.push(`  contradicts scored as supports (judged arm):    ${String(h.contradictsScoredSupports)}`);
  lines.push(`  unreadable scored as supports (judged arm):     ${String(h.unreadableScoredSupports)}`);
  lines.push(
    `  citations whose URL resolves and whose page does not support the claim: ${String(h.liveButUnsound)} of ${String(report.support.cases)} (${pct(h.liveButUnsoundShare)} of the resolving ones)`,
  );

  lines.push('');
  lines.push('# The registry family');
  lines.push('');
  lines.push(
    `  ${String(report.registry.cases)} cases · ${report.registry.labelCounts.map((c) => `${c.label} ${String(c.count)}`).join(' · ')}`,
  );
  lines.push(
    `  a registry that could not be reached, scored as a fabricated reference: ${String(report.registry.uncheckedScoredAbsent)}`,
  );
  lines.push(...renderArm(report.registry.arm));

  lines.push('');
  lines.push('# What none of these numbers can mean');
  lines.push('');
  for (const caveat of report.support.cannotMean) lines.push(`  - ${caveat}`);
  lines.push('');
  return lines.join('\n');
}
