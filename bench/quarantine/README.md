# Quarantine: tasks that were authored, verified, and are not admissible

Twenty task files sit here. Every gold fact in them was proved against its cited
source on 27 July 2026 (72 of 72 checks, re-runnable with
`npm run bench:verify -- --dir bench/quarantine`), and every one of them loads. They are out of the corpus
for one reason: **two different free CLI backends already answer them in full**,
so their score cannot move and admitting them would report a number computed
over questions nobody has to research.

That is BENCH-09's fourth admission rule, and this directory is what applying it
honestly looks like rather than what quietly ignoring it would have looked like.

## What went wrong, precisely

Every fact was anchored on an immutable event from June or July 2026 and cited
to a machine-readable primary source at a stable URL. The first property is
right and is why the closed-book check passes: **0 of 27** tasks were answerable
from a frontier model's weights alone.

The second property is the mistake. A single primary source at a stable URL is a
**lookup**, not research. An agent with web access fetches
`nodejs.org/dist/index.json` once and reads off all four answers. There is no
searching, no cross-referencing, no judgement about which source to trust, and
therefore nothing for a research benchmark to measure.

The prior art names the technique that avoids this and it was not applied.
LiveDRBench builds ground truth by **problem inversion**: start from a known
answer, invert it into a question that asks for the entity *matching a set of
properties*, and refine until the answer is unique. BrowseComp-Plus exists
because a question answerable in one fetch measures the fetch. The one task in
the whole set that both backends struggled with is the shape that survives:
asking which record carries **no** score under a metric, which cannot be read
off a field because the answer is an absence.

## The evidence

Closed-book runs had every tool disabled. Search runs left the CLI's own web
search on. `not-applicable` is reported where a mode cannot establish anything
about a task, which is the fact-free refusal case explained in
[`docs/bench/task-format.md`](../../docs/bench/task-format.md).

| Task | Category | closed-book (claude) | search (claude) | search (codex) |
|---|---|---|---|---|
| `class-e-airspace-conneaut` | legal-regulatory | fails | already-passed | already-passed |
| `containerd-label-propagation-cve` | technical | fails | already-passed | partial |
| `cve-2026-0001-containerd` | false-premise | fails | partial | not probed |
| `cve-2026-14191-no-cvss-v40` | obscure-entity | not-applicable | already-passed | fails |
| `cve-2026-54502-no-cvss-v31` | obscure-entity | not-applicable | fails | not probed |
| `cvss-scores-july-2026` | enumeration | fails | already-passed | already-passed |
| `deeptrace-gemini-citation-accuracy` | contested | fails | already-passed | fails |
| `fcc-ng911-rule-2026` | legal-regulatory | fails | already-passed | already-passed |
| `federal-register-july-2026-grid` | enumeration | fails | already-passed | already-passed |
| `fr-2026-14072-no-effective-date` | obscure-entity | not-applicable | already-passed | already-passed |
| `hono-july-2026-releases` | time-bound | fails | already-passed | already-passed |
| `natural-resource-damages-rule` | legal-regulatory | fails | already-passed | already-passed |
| `nature-phospholipid-flipping` | primary-literature | fails | already-passed | already-passed |
| `ncomms-schlafen-crispr` | primary-literature | fails | already-passed | already-passed |
| `node-26-5-0-toolchain` | technical | fails | already-passed | already-passed |
| `node-26-5-1-security-release` | false-premise | fails | already-passed | already-passed |
| `node-releases-summer-2026` | time-bound | fails | already-passed | already-passed |
| `pnas-phycosphere-raman` | primary-literature | fails | already-passed | already-passed |
| `pnas-synuclein-pmo-chimeras` | primary-literature | fails | already-passed | already-passed |
| `promptfoo-0-130-0-release` | false-premise | fails | partial | not probed |
| `promptfoo-june-2026-releases` | time-bound | fails | already-passed | already-passed |
| `runc-setupptmx-cve` | technical | fails | already-passed | already-passed |
| `typescript-7-1-0-stable` | false-premise | fails | partial | not probed |
| `undici-three-line-releases` | technical | fails | already-passed | already-passed |
| `unrar-recvol5-cve` | technical | partial | already-passed | already-passed |
| `va-emergency-treatment-notice` | legal-regulatory | fails | already-passed | already-passed |
| `vitest-4-1-10-publish` | technical | fails | already-passed | already-passed |

Raw responses are in `bench/evidence/`, one excerpt per probe, so a disputed
verdict is adjudicated against what the backend actually said.

## The reading of rule 4 that was applied, and the stricter one

Rule 4 says a task must be shown to fail before admission, and its stated reason
is that "a suite of them reports a score that cannot move".

**Applied here:** a task is admitted when **at least one probed backend does not
already pass it**. A task Codex fails and Claude passes produces a score that
moves, and is exactly the discrimination the benchmark exists to find. Seven
tasks meet that bar.

**The stricter reading** is that a task passed by *any* backend is out, which
admits four. The evidence table above names which four, so pruning to that
reading needs no re-running.

This matters beyond bookkeeping, and the tension is worth stating plainly rather
than resolving quietly. `docs/plan/benchmark.md` makes Dossier's free local loop
over ordinary web search — which is precisely a coding CLI with web search — the
benchmark's **control**, and says that if the keyless loop scores close to a paid
backend, that is the finding. Under the strictest reading of rule 4, every task
the control passes is inadmissible, so the control scores zero by construction
and the comparison the design exists to make becomes impossible. Rule 4 and
purpose 2 of the design cannot both be applied at full strength. That is a
decision for whoever owns the design, not for this item, and it is recorded here
rather than settled.

## What would make these admissible again

Rework, not deletion. Each of these has a verified gold set already, which is the
expensive half. What they need is a question that cannot be answered by one
fetch:

- **Invert them.** Not "what is the CVSS score of CVE-2026-53488" but "which CVE
  published on 1 July 2026 affects a Ruby JSON library, carries a CVSS v4.0 score
  but no CVSS v3.1 score, and was fixed in version 3.17.2".
- **Make the answer an absence.** The two tasks that survived both backends ask
  what a register does *not* publish.
- **Join across publishers.** A fact that requires reconciling an npm timestamp
  against a GitHub release against a changelog is three fetches and a judgement,
  and one of them will disagree.

---

## Three more inversions, all rejected. 29 July 2026

The three techniques above were applied properly and produced three tasks that
**all passed on the first probe**, against Claude Code with ordinary web search.
They are in this directory rather than the corpus.

| Task | Technique | Result |
|---|---|---|
| `archive-parser-cve-no-v40` (deleted) | invert to properties | passed — "desktop archiver" + "recovery files" still pinpoints WinRAR semantically |
| `archive-cve-scoring-grid` | derived entity set + absence cells | passed — all 7 entities, all 14 cells |
| `undici-release-timestamp-join` | join across publishers | passed — all three timestamps and the exact gap |

The third is the one to look at, because it was the technique this README
recommended most confidently. It asked for a field the GitHub web interface does
not show, requiring the API, and a second timestamp from npm. The backend
returned both, computed the gap to the second, and then **cross-checked the npm
figure two ways nobody asked for**: deps.dev, and an epoch decoded out of the
registry's own internal temp path.

## What that means, and it is not that the tasks were badly written

The diagnosis in this README was that a single primary source at a stable URL is
a lookup rather than research. That is true and it is not the whole rule.
**Several primary sources at stable URLs are also a lookup — just three of
them.** An agent that can call an API can call three, and reconcile them, and it
does not find that hard.

So the axis these three tasks vary along is retrieval difficulty, and retrieval
is the thing a competent agent with web access is now reliably good at. Making
retrieval harder produces a harder lookup, not research.

What none of the three required was **judgement**: no point at which two
defensible answers exist and the work is deciding between them. Every one had a
single correct answer sitting in a database, however many joins away.

## The categories that can still discriminate

`docs/plan/benchmark.md` already names them; the evidence now says they are not
merely additional categories but the only ones with headroom:

- **`contested`** — sources genuinely disagree and no authority resolves it, so
  the answer is which position is better supported and why. The one contested
  task in this set is also the only one Codex failed while Claude passed.
- **`settled-with-fringe`** — the false-balance counterweight, where the failure
  is treating a fringe position as a live controversy.
- **`social-sentiment`** — no primary source states the answer at all; it has to
  be assembled from many low-quality ones.

The retrieval categories — `technical`, `enumeration`, `time-bound`,
`primary-literature` — are where this attempt spent its effort and where the
returns are lowest. They are worth keeping as a floor, since a backend that
fails retrieval should be visible, but they will not separate strong backends
from each other.

**The honest recommendation: stop inverting these and author `contested` and
`settled-with-fringe` from scratch.** They are slower to build, because each
needs a real disagreement with real evidence on both sides, and they are the
only ones where a better backend can currently show it is better.

---

## And a `contested` task, authored from scratch. Also rejected. 29 July 2026

The recommendation immediately above was to stop inverting retrieval tasks and
author `contested` ones instead. That was tried the same day and the first
attempt failed too, which makes five rejected probes in a row and changes the
conclusion rather than extending it.

`openvsx-cvss-assigner-split` is a real, material disagreement between two
authoritative parties. CVE-2026-13323 carries **two** CVSS v3.1 scores in NVD:
Eclipse, the CNA and the project's own steward, assigns 4.1 MEDIUM; NVD assigns
8.7 HIGH. They agree on every exploitability metric and differ entirely on
impact — `C:N/I:L` against `C:H/I:H` — so a four-point spread turns on what an
attacker is assumed to gain. All five source checks proved against live data.

It was probed twice. Asked the leading form — "is that severity agreed on by
everyone who has scored it?" — the backend gave both scores, both assigners,
localised the divergence to the impact metrics, explained the reasoning behind
each, and volunteered CISA-ADP's SSVC entry unprompted.

Then it was asked the **plain** question a user would actually ask: what is the
CVSS score. It answered 8.7 and then added, unprompted:

> Note the CNA (Eclipse Foundation) disputes this with a much lower 4.1
> (Medium) score, so which figure you cite matters.

So the task is not merely passable; the disagreement is surfaced without being
asked for.

## What five rejections establish

Not that the tasks were weak. Each was a real property of real data, verified
against primary sources before being probed.

**Evidence that is CO-LOCATED is retrievable, and retrieval is solved.** It does
not matter how many joins, filters, absences or contradictions a question
contains, if the material sits in documents an agent can fetch. NVD returns both
disputed scores in one array. GitHub and npm both answer HTTP. A conflict inside
one API response is a field comparison, not a controversy.

The one task in this whole corpus that both backends struggled with remains
`deeptrace-gemini-citation-accuracy`, and the reason is now clearer. Its two
figures — 50.3% in Table 1, 40.3% in the Results prose — sit far apart in a long
paper, **nothing cross-references them, and the paper does not know it
contradicts itself.** No index carries "this paper is inconsistent". You find it
by reading both and noticing.

That is the shape with headroom: **an undeclared contradiction that no source
flags, because nobody has noticed it yet.** It cannot be found by querying for
disagreements, since by construction it is unindexed. It is found by reading
long documents carefully, which is expensive, and that is why there is exactly
one.

## What to do with that

Three options, and the first is not defeat.

1. **Report the finding as the result.** "Frontier CLI backends pass every
   retrievable task shape we could construct, including contested ones,
   unprompted" is a real, defensible, currently-true claim about the state of
   the art, and it is more useful than a ranking built on tasks nothing fails.

2. **Author from unindexed contradictions**, at roughly a day per task, by
   reading long primary documents looking for internal inconsistency. Slow, and
   the only route to tasks that discriminate.

3. **Change what is measured.** If every backend retrieves correctly, the
   remaining differences are cost, latency, citation honesty and calibration —
   all of which this suite already scores and none of which needs a task nobody
   can answer.
