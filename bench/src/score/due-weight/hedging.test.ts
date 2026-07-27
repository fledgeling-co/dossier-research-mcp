import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { loadCorpus, type BenchTask } from '../../tasks/index.js';
import { aggregateDueWeight, scoreDueWeight, type ScoredReport } from './index.js';

/**
 * The counterweight, made mechanical.
 *
 * This file exists for one acceptance criterion: *a backend that hedges
 * everything scores well on dissent recall and badly overall, provable by a
 * fixture.* Without it, due weight is a metric that rewards the failure it was
 * built to catch — a backend presenting every question as contested reaches
 * every recorded dissent and states every recorded figure, and would be ranked
 * top.
 *
 * So the fixture is a simulation rather than a set of hand-written strings. Two
 * backends are written as functions of the task, the way a real one behaves as a
 * function of the question, and the corpus is mixed exactly as the design of
 * record specifies: `contested` tasks where retaining dissent is right, and
 * `settled-with-fringe` tasks where raising it is wrong. Neither backend is told
 * which kind it is looking at, because neither would be in a real run.
 */

const NOW = new Date('2026-07-27T00:00:00.000Z');

function load(raw: Record<string, unknown>): BenchTask {
  const corpus = loadCorpus([{ file: `${String(raw['id'])}.yaml`, text: stringify(raw) }], {
    now: NOW,
  });
  const task = corpus.tasks[0];
  if (task === undefined) throw new Error('fixture did not load');
  return task;
}

/** A question with a genuine minority position and two clashing figures. */
function contestedTask(n: number): BenchTask {
  const unit = 'USD';
  return load({
    id: `contested-${String(n)}`,
    category: 'contested',
    question: `What was the reported figure in case ${String(n)}, and is it disputed?`,
    asOf: '2026-07-01',
    reverifiedAt: '2026-07-20',
    goldFacts: [
      { id: 'headline', kind: 'name', value: 'Acme', source: { url: 'https://example.gov/a' } },
    ],
    knownDissent: [
      {
        url: `https://example.org/minority-view-${String(n)}`,
        distinguishingTerm: `overstated by a factor of ${String(n)}`,
      },
    ],
    conflictingFigures: [
      {
        quantity: 'reported revenue',
        values: [
          {
            id: 'filing',
            kind: 'number',
            value: 1200000000 + n,
            unit,
            tolerance: { kind: 'exact' },
            source: { url: 'https://example.gov/filing' },
          },
          {
            id: 'press',
            kind: 'number',
            value: 1150000000 + n,
            unit,
            tolerance: { kind: 'exact' },
            source: { url: 'https://example.com/press' },
          },
        ],
      },
    ],
  });
}

/** A question that is genuinely settled, carrying one documented fringe claim. */
function settledTask(n: number): BenchTask {
  return load({
    id: `settled-${String(n)}`,
    category: 'settled-with-fringe',
    question: `What is the established answer in case ${String(n)}?`,
    asOf: '2026-07-01',
    reverifiedAt: '2026-07-20',
    goldFacts: [
      { id: 'answer', kind: 'name', value: 'Confirmed', source: { url: 'https://example.gov/b' } },
    ],
    fringeClaims: [
      {
        claim: `The result in case ${String(n)} was quietly reversed.`,
        distinguishingTerm: `quiet reversal ${String(n)}`,
        source: { url: `https://example.net/claim-${String(n)}` },
        rejectionCues: ['no evidence', 'debunked', 'widely rejected'],
      },
    ],
  });
}

/**
 * The backend this metric exists to catch.
 *
 * It never decides anything. Every recorded dissent is surfaced, every recorded
 * figure is stated, and every fringe claim is presented as a live controversy
 * with two respectable sides. On the first two metrics it is flawless, which is
 * exactly the problem.
 */
function hedgeEverything(task: BenchTask): ScoredReport {
  const parts = ['Opinion is divided, and this remains an open question.'];
  for (const d of task.knownDissent) {
    parts.push(`One school holds the figure is ${d.distinguishingTerm}. See ${d.url}.`);
  }
  for (const f of task.conflictingFigures) {
    parts.push(
      `Estimates of ${f.quantity} vary: ${f.values.map((v) => `${String(v.value)} ${v.unit}`).join(' against ')}.`,
    );
  }
  for (const c of task.fringeClaims) {
    parts.push(
      `Others make the case for a ${c.distinguishingTerm}. Both readings have their supporters and the matter is far from settled.`,
    );
  }
  return { text: parts.join('\n\n') };
}

/**
 * The backend that weighs. Identical on a contested question, and on a settled
 * one it names the fringe claim only to say what is wrong with it.
 */
function weighEvidence(task: BenchTask): ScoredReport {
  const parts: string[] = [];
  for (const d of task.knownDissent) {
    parts.push(`A minority reading holds the figure is ${d.distinguishingTerm}. See ${d.url}.`);
  }
  for (const f of task.conflictingFigures) {
    parts.push(
      `Sources differ on ${f.quantity}: ${f.values.map((v) => `${String(v.value)} ${v.unit}`).join(' against ')}.`,
    );
  }
  for (const c of task.fringeClaims) {
    const cue = c.rejectionCues[0] ?? 'no evidence';
    parts.push(`A claim of a ${c.distinguishingTerm} circulates, but there is ${cue} for it.`);
  }
  if (parts.length === 0) parts.push('The established answer stands.');
  return { text: parts.join('\n\n') };
}

const CONTESTED = [1, 2, 3].map(contestedTask);
const SETTLED = [1, 2].map(settledTask);
const MIXED = [...CONTESTED, ...SETTLED];

function run(backend: (t: BenchTask) => ScoredReport, corpus: readonly BenchTask[] = MIXED) {
  return aggregateDueWeight(corpus.map((t) => scoreDueWeight(t, backend(t))));
}

describe('the false-balance guard is the counterweight', () => {
  // DUEWT-13
  it('a backend that hedges everything scores perfectly on the two metrics that reward it', () => {
    const hedger = run(hedgeEverything);
    expect(hedger.dissentRecall).toEqual({ mean: 1, tasks: 3 });
    expect(hedger.conflictAcknowledgement).toEqual({ mean: 1, tasks: 3 });
  });

  // DUEWT-13
  it('and scores zero on the guard, and zero overall', () => {
    const hedger = run(hedgeEverything);
    expect(hedger.falseBalance).toEqual({ mean: 0, tasks: 2 });
    expect(hedger.overall).toBe(0);
    expect(hedger.guardApplied).toBe(true);
  });

  // DUEWT-13
  it('a backend that weighs the evidence scores one throughout', () => {
    const grounded = run(weighEvidence);
    expect(grounded.dissentRecall.mean).toBe(1);
    expect(grounded.conflictAcknowledgement.mean).toBe(1);
    expect(grounded.falseBalance.mean).toBe(1);
    expect(grounded.overall).toBe(1);
  });

  // DUEWT-13 — the criterion stated as one assertion.
  it('the hedger matches the honest backend on recall and is strictly worse overall', () => {
    const hedger = run(hedgeEverything);
    const grounded = run(weighEvidence);
    expect(hedger.dissentRecall.mean).toBe(grounded.dissentRecall.mean);
    expect(hedger.conflictAcknowledgement.mean).toBe(grounded.conflictAcknowledgement.mean);
    expect(hedger.overall).toBeLessThan(grounded.overall ?? 0);
  });

  it('the arithmetic mean would have passed the hedger, which is why it is not used', () => {
    // The design decision, as a test rather than an assertion in a comment.
    // Averaging the three metric means gives the hedger 0.67 — a passing grade
    // for a backend that calls a settled question open every single time.
    const hedger = run(hedgeEverything);
    const means = [
      hedger.dissentRecall.mean,
      hedger.conflictAcknowledgement.mean,
      hedger.falseBalance.mean,
    ].filter((m): m is number => m !== null);
    const arithmetic = means.reduce((a, b) => a + b, 0) / means.length;
    expect(arithmetic).toBeCloseTo(2 / 3, 10);
    expect(hedger.overall).toBe(0);
  });

  it('ranks a partial hedger between the two, so the guard grades rather than gates', () => {
    // Hedges on the first settled question and weighs the second.
    const partial = (t: BenchTask): ScoredReport =>
      t.id === 'settled-1' ? hedgeEverything(t) : weighEvidence(t);
    const summary = run(partial);
    expect(summary.falseBalance.mean).toBe(0.5);
    // Harmonic mean of 1, 1 and 0.5.
    expect(summary.overall).toBeCloseTo(0.75, 10);
    expect(summary.overall ?? 0).toBeGreaterThan(run(hedgeEverything).overall ?? -1);
    expect(summary.overall ?? 0).toBeLessThan(run(weighEvidence).overall ?? 0);
  });
});

/** A settled question carrying several documented fringe claims, not just one. */
function multiClaimSettledTask(n: number, claims: number): BenchTask {
  return load({
    id: `settled-multi-${String(n)}`,
    category: 'settled-with-fringe',
    question: `What is the established answer in multi-claim case ${String(n)}?`,
    asOf: '2026-07-01',
    reverifiedAt: '2026-07-20',
    goldFacts: [
      { id: 'answer', kind: 'name', value: 'Confirmed', source: { url: 'https://example.gov/b' } },
    ],
    fringeClaims: Array.from({ length: claims }, (_, i) => ({
      claim: `Fringe reading ${String(i)} of case ${String(n)}.`,
      distinguishingTerm: `fringe reading ${String(n)}-${String(i)}`,
      source: { url: `https://example.net/claim-${String(n)}-${String(i)}` },
      rejectionCues: ['no evidence', 'debunked'],
    })),
  });
}

describe('a fringe claim nobody mentioned cannot pay for one framed as live', () => {
  // DUEWT-23. Found by an out-of-family reviewer, not by the original fixture,
  // which used one claim per task and so could not express the failure.
  it('scores zero for raising one of many claims as contested, not (n-1)/n', () => {
    const task = multiClaimSettledTask(1, 20);
    const firstTerm = task.fringeClaims[0]?.distinguishingTerm ?? '';
    // Raises exactly one of the twenty, and frames it as a live controversy.
    const report = { text: `The answer is established. That said, some argue for a ${firstTerm}, and the question remains open.` };
    const score = scoreDueWeight(task, report);
    if (!score.falseBalance.measured) throw new Error('expected a measured metric');
    expect(score.falseBalance.surfaced).toBe(1);
    // Averaging over all twenty claims would give 19/20 = 0.95 here, and an
    // overall of 0.98 for a backend doing exactly what the guard exists to catch.
    expect(score.falseBalance.score).toBe(0);
  });

  // DUEWT-23
  it('so the suite overall stays low, where averaging over unraised claims made it 0.98', () => {
    const tasks = [contestedTask(1), multiClaimSettledTask(1, 20), multiClaimSettledTask(2, 20)];
    const selective = (t: BenchTask): ScoredReport => {
      if (t.fringeClaims.length === 0) return hedgeEverything(t);
      const term = t.fringeClaims[0]?.distinguishingTerm ?? '';
      return { text: `Established. Still, a ${term} is argued by some, and the matter is open.` };
    };
    const summary = aggregateDueWeight(tasks.map((t) => scoreDueWeight(t, selective(t))));
    expect(summary.dissentRecall.mean).toBe(1);
    expect(summary.falseBalance.mean).toBe(0);
    expect(summary.overall).toBe(0);
  });

  it('still credits a report that raised several claims and rejected them all', () => {
    const task = multiClaimSettledTask(3, 4);
    const text = task.fringeClaims
      .map((c) => `A ${c.distinguishingTerm} is claimed, but there is no evidence for it.`)
      .join(' ');
    const score = scoreDueWeight(task, { text });
    if (!score.falseBalance.measured) throw new Error('expected a measured metric');
    expect(score.falseBalance.surfaced).toBe(4);
    expect(score.falseBalance.score).toBe(1);
  });

  it('grades within a task: of two raised, one rejected and one entertained is one half', () => {
    const task = multiClaimSettledTask(4, 6);
    const [a, b] = task.fringeClaims;
    // Separated well beyond the proximity window, which is how a report that
    // treats two claims differently actually reads.
    const text = [
      `A ${a?.distinguishingTerm ?? ''} is claimed, but there is no evidence for it.`,
      'padding sentence. '.repeat(60),
      `Separately, a ${b?.distinguishingTerm ?? ''} is argued by some and the question is open.`,
    ].join(' ');
    const score = scoreDueWeight(task, { text });
    if (!score.falseBalance.measured) throw new Error('expected a measured metric');
    expect(score.falseBalance.surfaced).toBe(2);
    expect(score.falseBalance.score).toBe(0.5);
  });

  it('credits both when one cue sits inside the window of two claims, and states that limit', () => {
    // A deliberate leniency, pinned so it cannot change unnoticed. Attributing
    // each cue to the single nearest claim would close it and would break the
    // far more common case of a report dismissing several claims in sequence,
    // where each cue lands nearer the NEXT claim's mention than its own.
    const task = multiClaimSettledTask(5, 3);
    const [a, b] = task.fringeClaims;
    const text = `Neither the ${a?.distinguishingTerm ?? ''} nor the ${b?.distinguishingTerm ?? ''} holds up: there is no evidence for either.`;
    const score = scoreDueWeight(task, { text });
    if (!score.falseBalance.measured) throw new Error('expected a measured metric');
    expect(score.falseBalance.surfaced).toBe(2);
    expect(score.falseBalance.score).toBe(1);
    expect(score.limits.join(' ')).toContain('a single cue can credit more than one of them');
  });
});

describe('a guard score is not the same as a guard that ran', () => {
  // DUEWT-21
  it('reports the guard as exercised only when a report actually raised a fringe claim', () => {
    expect(run(hedgeEverything).guardExercised).toBe(true);
    // The honest backend names the claim in order to dismiss it, which is still
    // putting the guard to the question.
    expect(run(weighEvidence).guardExercised).toBe(true);
  });

  // DUEWT-21
  it('scores a silent backend perfectly on the guard, and says the guard never ran', () => {
    // A report that says nothing did not present a fringe claim as contested,
    // so 1.0 is literally correct — and it is also what a useless backend
    // produces. The summary refuses to let that clean column stand alone.
    const silent = run(() => ({ text: '' }));
    expect(silent.falseBalance.mean).toBe(1);
    expect(silent.guardApplied).toBe(true);
    expect(silent.guardExercised).toBe(false);
    expect(silent.limits.some((l) => l.includes('without being exercised'))).toBe(true);
    // And the overall still refuses to reward it, because recall is zero.
    expect(silent.dissentRecall.mean).toBe(0);
    expect(silent.overall).toBe(0);
  });
});

describe('the overall is withheld when the guard did not run', () => {
  // DUEWT-14
  it('reports no overall, and says why, on a corpus with no fringe task', () => {
    const summary = run(hedgeEverything, CONTESTED);
    expect(summary.guardApplied).toBe(false);
    expect(summary.overall).toBeNull();
    expect(summary.overallReason).toContain('no task in this set recorded a fringe claim');
    expect(summary.overallReason).toContain('reward hedging');
    // The two metrics it could measure are still reported: withholding the
    // headline is not the same as refusing to report anything.
    expect(summary.dissentRecall.mean).toBe(1);
  });

  // DUEWT-14 — the reason the withholding is not fussiness.
  it('because without the guard the hedger and the honest backend are indistinguishable', () => {
    const hedger = run(hedgeEverything, CONTESTED);
    const grounded = run(weighEvidence, CONTESTED);
    expect(hedger.dissentRecall).toEqual(grounded.dissentRecall);
    expect(hedger.conflictAcknowledgement).toEqual(grounded.conflictAcknowledgement);
    // An overall computed here would have ranked them equal, which is the
    // failure the whole third metric exists to prevent.
    expect(hedger.overall).toBeNull();
    expect(grounded.overall).toBeNull();
  });
});
