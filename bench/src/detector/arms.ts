import { MemoryRegistryCache, RateLimiter, SingleFlight } from '../citations/cache.js';
import { collectCitationEvidence } from '../citations/collect.js';
import type { FetchedPage } from '../citations/fetch.js';
import { REGISTRY_IDS } from '../citations/registries.js';
import { containment, type SourceEvidence } from '../score/containment.js';
import type { Judgement } from './confusion.js';
import type { LoadedRegistryCase, LoadedSupportCase } from './corpus.js';
import type { JudgedVerdicts, RegistryLabel, SupportLabel } from './schema.js';
import {
  abstained,
  collapseDecision,
  collapseLabel,
  decided,
  projectContainment,
  projectLinkCheck,
  projectLinkCheckSoundness,
  type Decision,
  type SoundnessLabel,
} from './verdicts.js';

/**
 * The detectors, driven over the labelled corpus.
 *
 * **Nothing here counts anything.** Each arm turns a case into a decision, and
 * `confusion.ts` does the arithmetic, so the counting can be tested against a
 * matrix worked out by hand without a detector anywhere near it.
 *
 * The judged arm reads verdicts a manual pass recorded and **never calls a
 * model**. That is not caution about cost, though it is that too. A model call
 * is asynchronous, non-deterministic and billed, and a scorer with any one of
 * those three properties cannot be re-run over a stored corpus, which is the
 * whole reason BENCH-03 split collection from scoring in the first place.
 */

/** The shape `containment` needs, built from a frozen case. */
export function pageEvidence(supportCase: LoadedSupportCase): SourceEvidence {
  return {
    url: supportCase.url,
    text: supportCase.pageText,
    truncated: supportCase.page.truncated,
    verdict: supportCase.page.verdict,
    completeHtml: supportCase.page.completeHtml,
    // Empty on purpose. Containment never reads anchors, and the corpus does not
    // carry them; anchor honesty is scored by BENCH-03 against live evidence.
    anchors: [],
  };
}

/**
 * The free arm: token containment, called exactly as the scorer calls it.
 *
 * Unmodified on purpose. The job here is to measure how weak this is, and any
 * tuning done to make the number look better would destroy the measurement it
 * exists to produce.
 */
export function containmentJudgements(
  cases: readonly LoadedSupportCase[],
): Judgement<SupportLabel>[] {
  return cases.map((c) => ({
    caseId: c.id,
    trueLabel: c.label,
    decision: projectContainment(containment(c.claim, pageEvidence(c)).verdict),
  }));
}

/**
 * The paid arm: what a model answered, when somebody paid for it to.
 *
 * A case with no recorded verdict abstains, and a case the pass recorded as a
 * failure abstains with the error. Neither is a wrong answer: nobody asked, or
 * the asking failed, and counting either as a mistake would flatter the free arm
 * by exactly the size of the outage.
 */
export function judgedJudgements(
  cases: readonly LoadedSupportCase[],
  judged: JudgedVerdicts | null,
): Judgement<SupportLabel>[] {
  const byCase = new Map((judged?.verdicts ?? []).map((v) => [v.caseId, v]));
  const failures = new Map((judged?.failures ?? []).map((f) => [f.caseId, f.error]));

  return cases.map((c) => {
    const recorded = byCase.get(c.id);
    if (recorded !== undefined) {
      return { caseId: c.id, trueLabel: c.label, decision: decided(recorded.verdict) };
    }
    const failure = failures.get(c.id);
    return {
      caseId: c.id,
      trueLabel: c.label,
      decision: abstained<SupportLabel>(
        failure === undefined
          ? judged === null
            ? 'no judged pass has been run against this corpus'
            : 'the judged pass recorded no verdict for this case'
          : `the judged pass failed on this case: ${failure}`,
      ),
    };
  });
}

/**
 * What `research_verify_citations` decides, replayed from the capture.
 *
 * The verdict on the frozen page is the one `judgeCitationStatus` reached at
 * capture time, so this arm is the product's own rule rather than a restatement
 * of it.
 */
export function linkCheckJudgements(
  cases: readonly LoadedSupportCase[],
): Judgement<SupportLabel>[] {
  return cases.map((c) => ({
    caseId: c.id,
    trueLabel: c.label,
    decision: projectLinkCheck(c.page.verdict),
  }));
}

/**
 * The degenerate strategy, which the corpus has to punish.
 *
 * Present as a real arm rather than as an argument in prose, so the balance
 * requirement is something a test asserts against the corpus that actually
 * shipped.
 */
export function alwaysSupportsJudgements(
  cases: readonly LoadedSupportCase[],
): Judgement<SupportLabel>[] {
  return cases.map((c) => ({
    caseId: c.id,
    trueLabel: c.label,
    decision: decided<SupportLabel>('supports'),
  }));
}

/**
 * Collapse a five-class arm into the binary soundness view.
 *
 * Cases whose true label is `unreadable` leave the view entirely, because
 * soundness is undetermined for a page nobody could read. An arm that answered
 * `unreadable` on a case that stayed in the view abstains rather than being
 * forced into one side of a question it did not answer.
 */
export function toSoundness(
  judgements: readonly Judgement<SupportLabel>[],
): Judgement<SoundnessLabel>[] {
  const out: Judgement<SoundnessLabel>[] = [];
  for (const judgement of judgements) {
    const trueLabel = collapseLabel(judgement.trueLabel);
    if (trueLabel === null) continue;
    const collapsed: Decision<SoundnessLabel> =
      collapseDecision(judgement.decision) ??
      abstained<SoundnessLabel>('the arm answered `unreadable`, which the soundness view does not ask about');
    out.push({ caseId: judgement.caseId, trueLabel, decision: collapsed });
  }
  return out;
}

/**
 * Link checking in the soundness view: the inference a reader draws, scored.
 *
 * `live` becomes `sound` here, and that is deliberately not what the tool
 * claims. It is what somebody does with a green link, and the whole point of the
 * view is to price that habit instead of warning about it in prose for a third
 * time.
 */
export function linkCheckSoundnessJudgements(
  cases: readonly LoadedSupportCase[],
): Judgement<SoundnessLabel>[] {
  const out: Judgement<SoundnessLabel>[] = [];
  for (const c of cases) {
    const trueLabel = collapseLabel(c.label);
    if (trueLabel === null) continue;
    out.push({ caseId: c.id, trueLabel, decision: projectLinkCheckSoundness(c.page.verdict) });
  }
  return out;
}

/** A transport that answers a case's scripted responses in order, then refuses. */
export function scriptedTransport(
  responses: readonly {
    readonly status: number;
    readonly body: string;
    readonly error?: string | undefined;
  }[],
): (url: string) => Promise<{ status: number; body: string; error?: string }> {
  let cursor = 0;
  return (_url: string) => {
    const response = responses[cursor];
    cursor += 1;
    if (response === undefined) {
      // Running off the end is a mis-authored case, not a network condition. It
      // surfaces as a transport failure, which the loop reads as `unchecked`, so
      // a case short of a response can never manufacture an `absent`.
      return Promise.resolve({
        status: 0,
        body: '',
        error: 'the case scripted no further registry response',
      });
    }
    return Promise.resolve(
      response.error === undefined
        ? { status: response.status, body: response.body }
        : { status: response.status, body: response.body, error: response.error },
    );
  };
}

/** A page fetcher that reaches nothing, since the registry family cites no pages. */
function offlineFetch(url: string): Promise<FetchedPage> {
  return Promise.resolve({
    url,
    status: 0,
    ok: false,
    body: '',
    contentType: '',
    truncated: false,
    error: 'the registry family does not fetch pages',
  });
}

const REGISTRY_CLOCK = new Date('2026-07-27T00:00:00.000Z');

/**
 * Drive the **production** registry loop over one case.
 *
 * `collectCitationEvidence` unchanged, with the transport, the clock, the cache
 * and the limiter injected. Reimplementing the step loop here would test a copy
 * of the rule rather than the rule, which is the failure mode `CLAUDE.md` names
 * about two implementations of one thing eventually disagreeing.
 *
 * A fresh cache and single-flight map per case, because two cases can carry the
 * same identifier with different scripted answers, and a shared cache would let
 * the first decide the second.
 */
export async function registryDecision(
  registryCase: LoadedRegistryCase,
): Promise<Decision<RegistryLabel>> {
  const evidence = await collectCitationEvidence(registryCase.reportSnippet, {
    registryTransport: scriptedTransport(registryCase.responses),
    fetchPage: offlineFetch,
    cache: new MemoryRegistryCache(),
    // Zero gaps and an instant sleeper: the gate must not wait six seconds for
    // the NVD's rate limit to elapse against a transport that never leaves the
    // process. The limiter's own timing is BENCH-03's to test, and it does.
    limiter: new RateLimiter({
      gaps: Object.fromEntries(REGISTRY_IDS.map((id) => [id, 0])),
      sleep: () => Promise.resolve(),
      now: () => 0,
    }),
    flight: new SingleFlight(),
    now: () => REGISTRY_CLOCK,
  });

  const answer = evidence.registry.find(
    (r) => r.kind === registryCase.kind && r.id === registryCase.identifier,
  );
  if (answer === undefined) {
    // The extractor did not find the identifier in the snippet at all. That is a
    // real detector outcome and is reported as an abstention rather than being
    // quietly scored as `unchecked`, because the two have different causes: one
    // is a registry that would not answer, the other is a citation this code
    // cannot see.
    return abstained<RegistryLabel>(
      `the identifier was not extracted from the report snippet, so no registry was asked about it`,
    );
  }
  return decided(answer.status);
}

export async function registryJudgements(
  cases: readonly LoadedRegistryCase[],
): Promise<Judgement<RegistryLabel>[]> {
  const out: Judgement<RegistryLabel>[] = [];
  for (const registryCase of cases) {
    out.push({
      caseId: registryCase.id,
      trueLabel: registryCase.label,
      decision: await registryDecision(registryCase),
    });
  }
  return out;
}
