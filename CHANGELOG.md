# Changelog

Every release that changed what the server does, what it costs, or what it needs to run.

Dates are the release date. Costs are estimate bands, never quotes. Where a fact was learned from a live API call rather than from vendor documentation, it says so, because that distinction turned out to matter more than once.

This project follows [semantic versioning](https://semver.org/). Until 1.0 the minor number carries breaking changes.

## [Unreleased]

### Changed

- **The benchmark report now says whether a difference between two backends is measurable, and mostly the answer is no.** `bench/src/report/` could rank backends and refuse to rank them, and the thing it could not do was tell you whether a gap it printed would survive being resampled. It said as much on every ranking. It now does the test.

  Four things landed, in `bench/src/stats/` and wired into the report rather than beside it. Backends are compared **paired**, on the tasks they both answered, because an unpaired test throws away the pairing that makes the comparison powerful. Every difference carries a 5,000-resample bootstrap interval, and **an interval containing zero is reported as `no measured difference`, in those words**, never as a smaller number a reader will rank anyway. Standard errors are **clustered on category** and printed beside the naive ones with the ratio between them, because two tasks in one category are not two independent observations and published measurement puts the resulting inflation at up to 3.05x, in the direction that flatters whichever backend happened to win. `pass^k` is reported beside `pass@1` with `k` stated, since a backend at high `pass@1` and low `pass^k` sometimes works and reporting only the first sells it as one that does.

  Completion became a **floor** as well as a column. A backend that completed too small a share of its attempted cells in a scope now renders `invalid` there rather than as a number, because a figure computed over whichever attempts survived describes the attempts that survived. The share is 0.6, derived from the design's own five-repetition target and three-repetition floor rather than picked, and it is configurable with `--min-completion`.

  An out-of-family review of the slice found five ways the report could have contradicted itself, all fixed before it shipped: a comparison the paired test refused used to hand the question back to the weaker interquartile check and publish a category ordering anyway; the ranking could print an order its own paired test disagreed with; the scorecard called a backend invalid while the ranking admitted it, because each derived the verdict separately; and `pass@1` and `pass^k` ignored failures completely, so a backend with three passes and seven failures per task read as perfectly reliable. `docs/bench/statistics.md` records them, along with the two findings that were decisions rather than defects.

  Two consequences worth knowing before reading a report. The bootstrap resamples **categories** as units, so a category-scoped comparison cannot be clustered at all and is refused outright: within one category there is no replication across clusters, and a task-level interval there would assume the independence the correction exists to deny. And on the corpus as it stands, seven tasks across four categories, **no pairwise comparison can be run at all**, which the report now says above every score rather than in a footnote. That is the correct answer for a corpus this size and the fix is authoring tasks.

- **`research_verify_claims` now says how much weaker its free mode is, with numbers.** The tool has always offered two paths, token containment for nothing or a model judging for a small fee, and it described them as a choice without saying what the choice costs. It costs a great deal. On a 30-case labelled corpus: containment passed **11 of 23 bad citations as supporting**, including every overstatement and four of seven outright contradictions; the judged pass let none through.

  The cause is structural rather than a threshold to tune. A contradiction states the opposite of a page using that page's own numbers and names, so a token check has nothing to see. One case in the corpus asserts the exact reverse of a sentence on the page and every token it carries appears on that page.

  Containment stays the default, because a check that costs money per run gets run once and then never again. What changes is that the price is now a measurement in the tool description and in `docs/tools.md`, rather than an assumption a reader has to make.

  From the same corpus, and about `research_verify_citations` rather than this tool: **22 of 30 pages resolve HTTP 200 and do not support the claim attached to them**, and three of four cookie or login walls are served with HTTP 200. Reading a green link as a sound citation scores identically to answering "supports" to everything.


### Fixed

- **Codex reported "failed to answer" while three other CLIs answered, and a CLI was being run in your project directory.** Two defects, both mine, found together because one hid the other.

  A spawned CLI inherited the server's working directory. For a stdio MCP server that is the client's working directory, so a research agent with shell access was standing in the user's own codebase while holding a brief that may itself have come from a hostile page. Nothing in a brief asks it to touch files and nothing stopped it. Every CLI now runs in an empty, git-initialised scratch directory under the store.

  And `codex exec` refuses any directory it does not consider trusted. Its trust list is granted interactively, so no headless invocation can ever satisfy it, which is why `--skip-git-repo-check` is now in its argv. That flag is only defensible alongside the scratch directory: the check exists to stop an agent editing files nobody can revert, and an empty repo satisfies that purpose even though it bypasses the mechanism. Skipping it while standing in the user's project would not have been.

  Underneath both, a CLI given its prompt in argv may still wait on stdin, and `execFile` leaves that an open pipe. `execFile` also accepts a `stdio` option and ignores it, because it manages stdio itself, so the obvious fix looks applied and does nothing. Probes now spawn with stdin closed. The research path never had this bug; only the probe path did.

  I met the trusted-directory error by hand earlier the same day, worked around it in my own test with a scratch repo and the flag, and did not connect it to how the product invokes the same binary. That is the same defect-restated-as-a-precondition pattern this project keeps finding in its own tests.

- **Two runs of one backend could be merged into a single label, and then their shared sources read as unique to it.** `research_synthesise` labels provenance per run rather than per backend, because keying on the backend name collapses several runs into one label and the overlap then reads 0% however much the runs actually shared. The label was the first six characters of the run id, so two runs whose ids share a six-character prefix produced one label and reintroduced exactly that collapse from the other direction: both runs merge, every source reads as unique to the surviving label, and the overlap reports the opposite of the truth. Run ids are sixteen hex characters, so this is improbable per merge rather than impossible, and it is silent when it happens.
  The short form is now used only while it is unambiguous, and a backend whose runs collide falls back to the full run id for all of that backend's runs. Found by BENCH-11 building a second consumer of the merge, and the test was checked in both directions against the old implementation.

- **The test suite failed eleven times in any git worktree, for a reason that had nothing to do with the branch being tested.** Nothing in the shipped server changes here; this is the benchmark harness, and it is in the changelog because it decided whether a contributor could trust a red test.

  `bench/src/detector/cli.test.ts` spawned the tsx binary and found it at a literal `../../../node_modules/.bin/tsx`. A git worktree has no `node_modules` of its own, so every one of its eleven cases failed there until somebody ran `npm install` inside the worktree. The whole feature pipeline runs in worktrees, so a runner checking out a branch met eleven red tests it had not caused and had to work out whether it had broken something. That is how a project trains people to work around a red test rather than investigate it.

  Ten of those cases never needed a process. The command is now `runDetector(args, io)`: arguments in, exit code out, output through injected sinks, with the same self-invocation guard `bench/src/report/cli.ts` already uses, so importing the module no longer runs it. One case still spawns, because nothing an import can see proves that anything calls the entry point, and that one resolves tsx through Node's own resolution instead of an assumed layout. If it ever cannot resolve one, it skips with a reason naming the binary and the fix rather than failing.

  Found by BENCH-11, which hit it on a fresh worktree and said it would bite every future runner.

### Added

- **`research_ground`: a finished report is now an input to the next question.** `research_export` wrote a report to disk and `corpusStores` grounded a run in a File Search store, and nothing connected them, so using what you had just learned meant exporting by hand, uploading by hand and remembering the store name. Dossier's own output was the one kind of evidence it could not easily consume, and a second question on the same subject started from nothing. The idea is Bridgewater's Pocket Analyst, whose analysis outputs land in the same store its inputs came from, so any output can serve as an input to the next one.

  **The default destination is local and needs no key.** It writes the report into a fixed `dossier-grounding/` subdirectory of the first directory the operator granted with `DOSSIER_LOCAL_CORPUS_DIRS`, opens no network connection, and `corpus_local_search` finds it afterwards like any other file there. `destination: "upload"` puts it in a Gemini File Search store instead, which **sends the report to Google**; the description says so, the annotation is non-read-only, and it has to be asked for by name.

  **The caller cannot choose where a local file goes.** No directory, no subdirectory, no file name, and an existing store is required rather than created for the upload path. `DOSSIER_LOCAL_CORPUS_DIRS` is operator-set and there is deliberately no tool that adds one, because a file reader an agent can aim is an exfiltration primitive; a file *writer* an agent can aim is worse, so the same boundary holds. Files are written `0600` inside a `0700` directory, on the same rule that made store files `0600` after the July review.

- **A run grounded in prior Dossier output declares it, and that output never counts as corroboration.** Pass `groundedInRunIds` to `research_plan` / `research_start` and the run records what it was built on, the prompt carries the rule, and `research_read` and `research_export` lead with a header naming the prior runs.

  **The failure being prevented is laundering, not inconvenience.** Report A asserts something weakly supported, run B reads A and repeats it, and the assertion now appears in two reports: that looks like accumulation and is amplification. So a prior report is the requester's own document under the existing circular-verification rule, valid primary evidence about what was previously concluded and never independent evidence that the conclusion was right. `classifySource` recognises one from the reference itself and returns `private-user-owned`, so `countsAsCorroboration` is false for it; `assessSupport` excludes it from the independent-domain count; and `research_synthesise` lists it as a source while adding nothing to the merge's breadth. A claim carried in from a grounding report and repeated in the new one counts once.

  One deliberate exception, named rather than left to be discovered: `research_evidence`'s **source mix** still lists a prior report among the sources it profiles, because the mix describes what was read and the report genuinely was read. It shows up classified as your own document. The advisory floors are advisory and never refuse anything.
### Added

- **Every combination of backends is now scored, without running any of them, in `bench/src/combine/`.** The run harness stores each cell raw, so a combination is the merge of reports already bought and all 2^N subsets are evaluated offline. The whole lattice makes zero network calls and spends nothing, asserted by a test that replaces `fetch` with a throwing stub and a second that reads every source file and fails on an import that could fetch. Documented in [`docs/bench/combinations.md`](docs/bench/combinations.md).

  **It is valid for exactly one reason, and that reason is a refusal rather than a comment.** Merging stored reports reproduces what a live panel would have had only because panel members are independent: each gets the same brief and never sees another's output. A member marked as having seen another is thrown on, so if that ever changes somebody meets a failing test instead of a paragraph they can skim.

  **Overlap is measured three ways and given no direction.** Pairwise Jaccard over canonical URLs, the same over registrable domains with the gap between them reported because it is the informative part, and the share of the union surviving the loss of any one member. There is deliberately no lowest-overlap function, no comparator and no ranking, and the frontier's candidate shape is closed at three fields so overlap has nowhere to sit. Less overlap is not monotonically better: two backends reaching the same document without seeing each other's work is evidence that document is what anyone competent would find, so a near-zero-overlap combination may simply contain a member missing what everyone else found. A `missedCentral` count is what separates broad from eccentric, and a fixture proves the distinction bites: the member with the most unique sources and the lowest overlap tops the credit split over a raw source count and comes last, at zero, over the measure that decides.

  **The frontier is three axes, not two.** A combination matching another's score at the same price while surviving the loss of a member better is the better buy, and two axes report that as a tie. The score axis is a named measure with a declared direction, because the scorers deliberately expose no single blended number and a lower-is-better one compared as though higher were better ranks the worst result first.

  **Marginal contribution is exact or refused, never sampled.** Shapley and Banzhaf are both computed and both named, because the design asks for one in words and names the other. Above sixteen members the answer is a refusal that names the count, says plainly that sampling is not offered, and names both ways back under the ceiling. An approximate Shapley value is indistinguishable from an exact one once it is a number in a table.

  Cost splits three ways rather than one: metered dollars, subscription runs counted and never costed, and runs whose spend cannot be established. A subscription CLI is not free, and folding its quota in as zero would put every subscription combination at the cheap end of the frontier by construction. Failed cells are carried, so completion rate stays measurable; scoring only the cells a backend happened to finish makes an unreliable backend look better than a reliable one.

  It changes no routing. The paid-lane join in `src/providers/registry.ts` still rests on one observation of 4% overlap; this produces the measurement that would justify changing it, and the two are deliberately separate acts.

- **A report you can act on, from benchmark cells already bought, in `bench/src/report/`.** Reads the JSONL cell store, the corpus and each stored report, and renders a per-backend scorecard, a category matrix, and the price beside every score. It runs no research, calls no model and cannot spend money; the only file in it that opens anything is the CLI. Documented in [`docs/bench/reporting.md`](docs/bench/reporting.md).

  **It refuses to rank when the sample cannot support one, and that refusal is the feature.** At one repetition per cell it prints every number and states no ordering. Below the configured minimum tasks, it names the category and leaves it unscored. A benchmark that produces confident rankings from too little evidence is the exact failure this product argues against, appearing in its own output.

  **The same defect then reappeared in the rendering, and was found in this tool's own output**, which is the strongest evidence available that the rule is worth enforcing. With the ranking correctly withheld, the category matrix still printed `74.5% [68.3%-80.8%] (n=6)` for a backend run once per task: a real six-task spread that to anybody skimming reads as run-to-run variance, next to a refusal to rank that a skimming reader would not reach. Such a value now carries a mark and a legend saying what its spread is not. A benchmark that produces confident-looking figures from too little evidence is the exact failure this product argues against, and it took two passes to keep it out of one page.

  The subtle case is the one worth recording, because it would have shipped silently. Aggregation collapses repetitions within a task before collapsing tasks within a category, which is the published practice that stops a large category dominating. But a backend run **once** per task across six tasks still has a perfectly good six-task spread, so a naive check on "does this figure have a spread" would have ranked a set of single runs. The repetition count is therefore carried up from the first stage and checked separately, taken over the weakest task rather than the average, because one task run once is enough to make the ordering partly noise.

  Even a stated ranking marks two backends as tied when their observed interquartile ranges overlap, and says on every table that an overlap check is descriptive rather than a significance test. Bootstrap intervals and paired differences are a separate slice; publishing a point-estimate ordering with unquantified uncertainty is what the published leaderboards in this field already do.

  **Three numbers go above every score rather than into a footnote**, each because it was learned the hard way rather than derived. Completion rate per backend, because `local-codex` was 0-for-3 here through an argument-parsing bug and `openai` 0-for-2 through rate limits, and both would have vanished from a naive average while the benchmark rewarded giving up. The stale-task count and share, because a score over a corpus that is a third stale is a different claim. And the registry `unchecked` count and share, because arXiv rate-limits nearly every probe, so a registry score computed over mostly-unchecked identifiers accuses backends of fabrication on the strength of checks that never ran.

  **Citation accuracy and citation volume are two tables and never one number.** A backend citing a hundred sources at eighty percent and one citing ten at eighty percent are different products. That is enforced by the metric registry rather than by convention: a volume metric has no direction, and the ranker refuses anything without one, so a count cannot become a leaderboard later.

  A failed cell counts against the completion rate and reaches no metric denominator. Nothing that could not be measured is rendered as a zero: every absence carries its own reason, including the four that look alike and are not, which are a failed cell, a task the metric does not apply to, a report the pipeline could not read, and a citation snapshot nobody collected.

  **Recency is reported unavailable, permanently, with the missing input named.** The durability axis needs a publication date per source and nothing in the stored results records one: the evidence snapshot carries when a page was *checked*, which is not when it was published. Approximating one from the other would grade every source fresh, so the gap is stated instead. The syndication-collapsed domain count is withheld for the same reason when no page text was compared, since it would otherwise equal the raw count and imply somebody had looked.

- **A self-eval: does this product's own checking actually work.** `bench/detector/` is a labelled corpus of 30 claim-and-page cases across the five verdicts `research_verify_claims` asks a caller for, plus 18 identifier cases across the four a registry can reach. `npm run bench:detector` scores it offline and prints a confusion matrix per detector arm. Documented in [`docs/bench/detector-eval.md`](docs/bench/detector-eval.md).

  **This eval inverts the benchmark's usual shape**, and everything else follows from that. Everywhere else a backend produces a report and code scores it; here the scorer *is* the system under test, so the answers have to exist before it runs and the arithmetic is a confusion matrix rather than a rate. Which makes the label vocabulary not ours to choose: it is the five the product already asks for, read out of `src/ai/utility.ts` by a parity test so the two cannot drift.

  **The headline finding is about the free path, and it is worse than the docs implied.** Token containment answered `supports` for **11 of the 23 citations a reader would call bad**: all six whose claim was stronger than the page supported, four of the seven the page contradicts outright, and one the page never addresses. The cause is structural rather than tunable. A contradiction and an overstatement both use the page's own numbers and names, so a check that asks whether those tokens appear has nothing to look at. Its five-class accuracy over the cases it answered is 30.8% against 23.3% for a detector that answers `supports` to everything, and 43.5% against 26.9% in the binary view.

  **The judged mode is much better, which was the question worth asking.** Over the same 30 cases it scored 80.0% five-class and 96.2% binary, waving through **zero** bad citations, with recall 1.00 on `contradicts` and on `unreadable`. Paired case by case: both right on 5, only the judged mode right on 19, only containment right on 3. Containment stays the default because it is free, exact and repeatable and the governing rule forbids a model in the scoring loop, but the price of that choice is now a number rather than an assumption. The judged pass is a manual step, spends a subscription quota rather than a metered balance, and refuses to start without `--confirm`.

  **Link checking is blind to this failure by construction, and the corpus prices that too.** 22 of the 30 cited pages resolve with HTTP 200 and do not support the claim attached to them, which is 75.9% of the resolving ones. `research_verify_citations` correctly declines to say anything about support in 29 of 30 cases; the exception is a publisher 403 it reads as `unreadable`. Three of the four walls in the corpus are served with HTTP 200 (a login wall, a script wall and a cookie-consent interstitial) and no status code can see any of them.

  **The corpus is frozen and tamper-evident.** Pages are captured through the production collector, not a second fetcher, and stored as text pinned by SHA-256; the loader recomputes the digest and refuses the whole corpus on a mismatch, because a confusion matrix computed over a fixture somebody edited is a number about a sample nobody chose. Every case carries a `why` of at least forty characters, enforced by the schema rather than by review: a label with no argument behind it is an assertion of authority.

  **Balance is asserted, not argued.** A test runs the degenerate strategy over the corpus that actually ships and requires it to score badly: 23.3% accuracy, macro-F1 0.076, recall 0 on `not_addressed`. Every abstention is reported three ways (precision and recall over answered, recall over every case, coverage) because the published guidance is explicit that those answer different questions and are not interchangeable preprocessing. And a verdict an arm *cannot* emit is marked `inexpressible`, so recall 0 on a ceiling never reads as a defect somebody could tune away.

  **The registry family scored 100% across all four verdicts**, including all six cases where the correct answer is `unchecked`: a 429, a 500, a thrown timeout, an unparseable 200, a handle 404 whose body is not the directory's own not-found code, and an arXiv feed naming a different paper. Zero were scored `absent`. That family drives the real `collectCitationEvidence` with a scripted transport rather than a copy of its step loop, so what passed is the rule that shipped.

## [0.10.0] - 2026-07-27

### Fixed

- **The same question, on the same backend, twice, was one paid run.** The dedupe fingerprint carried the prompt, tier, tools, plan-review flag, attachments, provider, shape and window, and no repetition index, so a deliberate repeat inside the dedupe window collapsed onto the first run. Nothing was wrong for ordinary use, where that is the protection working. It mattered the moment anyone wanted to measure variance: five repeats returned one report five times, and any spread computed from them was a single sample reported as five.

  A repeat is now expressible rather than dedupe being weakened, because dedupe exists to stop *accidental* duplicate spend and a deliberate repeat is not accidental. Omitting it, or passing zero, hashes exactly as before, which was checked at the wire rather than asserted: the fingerprint for an unchanged request is byte-identical across the change.

  Two further defects had to be fixed before that one worked, both found by an out-of-family review rather than by the change's author. The index was appended to a space-joined string whose last element was free text, so `wideSpec: "foo"` with repeat 7 hashed identically to `wideSpec: "foo repeat:7"` with none. And it was threaded through a truthiness test, where `NaN` is falsy, so a malformed index was silently dropped onto the no-repeat run.


### Added

- **A merge now says how much of each report was actually read, at the top.** Observed in a real session: an agent ran a panel of five, read one report in full, one executive summary, four sections of another's eighteen and nothing at all from a fifth, then wrote a confident synthesis as though it had read them all. Asked how, it said it had leaned on the merge tool's claims list as a substitute for reading, a list whose own output already said it measures coverage difference rather than agreement.

  The disclosure existed and did not work, because a caveat in the middle of a long output is something a reader in a hurry skims. This repo already knows the answer to that shape: a prompt can ask a model not to invent a supporting reference, and a server holding the registry can refuse the draft. One level up, a prompt can ask an agent to read the reports, and a server that records what it returned can say plainly how much was ever opened.

  **An outline is not the report**, and that distinction is the load-bearing one: an outline gives every heading and no content, which is exactly what makes it feel like having read. Outline, summary and grep reads are recorded and never counted toward coverage. Coverage counts distinct sections rather than calls, so re-reading one section while composing does not read as having covered a report.

- **Accuracy and relevance scoring for the benchmark, in `bench/src/score/`.** Accuracy decides, per recorded answer, whether a report actually stated it; relevance decides whether the report is about the right subject at all. Both are pure functions over a report's text and a loaded task, and neither reads a file, calls a network or asks a model anything. Documented in [`docs/bench/scoring.md`](docs/bench/scoring.md).

  **A gold fact missed on formatting was the failure worth engineering against.** `1.2 billion`, `1,200,000,000` and `1.2B` are one figure, and a scorer that knows one spelling of it reports every backend as worse than it is while saying nothing about why. Scaling therefore shifts a decimal point in a string rather than multiplying: `1.005 * 1e6` is `1004999.9999999999` and `0.267 * 1e9` is `267000000.00000003`, either of which fails an exact tolerance for reasons having nothing to do with research. Those cases were found by sweeping real figures rather than guessed, after the first draft of the test asserted `1.1 * 1e6` was inexact, which it is not.

  **A right figure with the wrong unit scores zero, not partial credit**, which is the reason the task format requires a unit. Units are canonicalised and never converted, and percent, percentage points, basis points and each currency stay distinct because those are the confusions being caught. A unit the lexicon has never heard of is its own class, so an author unit like `questions` or `CVSS v3.1 base score` works without a place in a global table. A figure with *no* unit beside it still counts and is reported as `unstated`: the corpus carries units no report will ever write out, and refusing them would be a false negative in the category where false negatives are most expensive.

  **Matching runs over prose, never citations.** Every citation form the existing extractor recognises is stripped first, including bare URLs and link text that is a bare hostname, because a backend that pasted a URL containing the figure did no reasoning. A test reads the forms out of the extractor rather than trusting a hand-written list to stay in step with it.

  **A value found only inside a denial is not recovered.** "Revenue was not 1.2 billion" contains the figure. The rule is a fixed cue list scoped to a clause and reported as exactly that rather than as comprehension; `no` is deliberately not a cue, because "no fewer than 303" asserts 303.

  Relevance is required-term coverage minus a drift penalty, clamped, with coverage and drift also reported separately. It is crude on purpose: it only separates an answer about the right subject from one that is not, and accuracy decides whether it is correct.

  The accuracy scorer's output is the recovery record the calibration scorer already took as an input, keyed by the answer id the task format requires for exactly that seam.
### Added

- **Citation integrity scoring for the benchmark, in `bench/src/score/` and `bench/src/citations/`.** Four checks over a report's citations, in increasing strength: does the URL resolve, does the identifier exist in its registry, does the cited page contain what the statement asserts, and does a cited fragment name anything on the page. Documented in [`docs/bench/citation-integrity.md`](docs/bench/citation-integrity.md).

  **An unreachable registry records `unchecked`, never `absent`, and `unchecked` leaves every denominator.** `absent` means a reference was fabricated, and saying that because a server was busy would make the benchmark the thing it exists to detect. Every check fails closed in one direction: a timeout, a 429, a 500, an unparseable body or a response shape that has changed since this was written all come back `unchecked`.

  All five registries were checked against the live services on 27 July 2026 rather than read from their documentation, and three do not behave the way the design assumed. **Crossref alone would report a genuine reference as fabricated**: it is one DOI registration agency among several, and the real `10.5281/zenodo.3509134` answers 404 from Crossref and 200 from the global handle directory, so an `absent` DOI now rests on that directory and a Crossref 404 decides nothing on its own. **The book catalogue answers found for a made-up number**: a fabricated ISBN resolves to a real community-edited record listing exactly that number, so an ISBN result is reported as catalogue presence and never as proof a book exists, in either direction. **arXiv refused every lookup across a seven-minute span with a 429**, so `unchecked` is the ordinary answer from that archive rather than the rare one. Two more answer HTTP 200 for something that does not exist, a missing PMID with an error buried in the body and an unknown CVE with a result count of zero, so reading the status alone would have scored every fabricated reference in both as real.

  Collection and scoring are separate halves. The collector reaches the network and writes one timestamped evidence snapshot; the scorer is pure and synchronous over a report plus that snapshot, so the same stored report scores the same twice and a metric added later can be applied to research already paid for. Every registry answer is cached on disk by identifier, an `unchecked` answer is never cached, and concurrent lookups of one identifier collapse onto a single request.

  The dimensions are DeepTRACE's (arXiv 2509.04499, ICLR 2026), read from the paper rather than a summary, so the numbers are comparable with published work. **Citation accuracy and citation volume are always reported as two numbers**, because a backend citing a hundred sources at eighty percent and one citing ten at eighty percent are different products. Three departures are named on every result rather than published silently under the paper's names: support comes from token containment instead of a model judge, the relevance-filtered denominators are reported unavailable instead of approximated, and an `unchecked` pair leaves the denominator instead of counting as unsupported.

  **Token containment is not entailment and says so on every result.** A page can contain "28.6%" while saying something else entirely about it. It is deliberately weaker than a reader and deliberately exact, repeatable and free; BENCH-10 measures the gap against a judged variant, which ships here as a real interface with no model on the default path.

### Changed

- **`src/research/citations.ts` exports the verdict rule it already had.** `judgeCitationStatus` and `judgeCitationError` were extracted from `verifyOne` unchanged, so the benchmark reads an HTTP status the same way the product does instead of restating the rule. Two implementations of one rule eventually disagree about what a 403 means.

### Fixed

- **A source dated after the as-of date was graded fresh if it was less than half a day after it.** `assessStaleness` compared a rounded day count, and `Math.round(-0.4)` is `-0` while `-0 < 0` is false, so the `after-horizon` branch never fired inside twelve hours. A back-dated source or a transcription error in that window was silently accepted as current, which is precisely the case that branch exists to catch. It now compares the timestamps. Found by BENCH-06 while building the benchmark's own copy of the rule, which is the argument for building a second implementation and diffing it against the first.


## [0.9.0] - 2026-07-27

### Fixed

- **A failed CLI now says why it failed.** The error read `the CLI exited with code 1` and stopped there, while the reason sat in the CLI's own captured output the whole time. Reported from a real panel where Claude Code failed twice with a bare code 1; the actual cause was an exhausted subscription, and a bare exit code makes that look like a broken adapter. The tail of the output now travels with the error, the tail rather than the head because a CLI that fails partway writes progress first and the error last.

- **A `--version` probe that timed out was reported as a binary that could not be identified.** Those are different findings and only one of them is the operator's problem. Under heavy local load a healthy CLI can miss the probe deadline, and `identity is unconfirmed` sends somebody to reinstall a tool that was never broken. A timeout now says it was a timeout, names the deadline, and says to re-run when the load drops.

- **The gate linted other branches' worktrees.** `.worktrees/` holds git worktrees of this same repository, so a half-written file on another branch failed the main tree's lint. Each worktree runs its own gate against its own branch; the main one no longer runs theirs.


### Added

- **Source quality, independence and syndication, under `bench/src/score/`.** Grades a report's cited sources into the product's own classes, counts the independent registrable domains behind it, and then finds the syndication that counting domains cannot see. Documented in [`docs/bench/source-quality.md`](docs/bench/source-quality.md).

  **The failure it exists for.** Four domains carrying one wire story are four domains and one source. Independent-domain counting reports four, because the four domains genuinely are four domains, and a report resting on all four looks four times better sourced than it is. Detection is Broder shingling over the fetched page text: ten-word runs, hashed, compared by resemblance at 0.7 or by containment at 0.9. Containment is there because resemblance alone misses the ordinary case, since an outlet running half a wire story verbatim can never exceed about 0.5 resemblance however word-perfect it is.

  **Both counts are reported, always, and the collapsed one is never reported alone.** The threshold is a judgement, and a reader who disagrees with it needs the raw figure to reason from. Every constant carries its provenance in the code: the ten-word shingle is Broder, Glassman, Manasse and Zweig (WWW6, 1997) quoted directly, 0.7 is the figure this repo already recorded for `last30days-skill` in `docs/plan/external-skill-gap-analysis.md`, and the published anchors either side are Broder's own 0.50 and the 0.9 in Manning, Raghavan and Schuetze. Landing between them is stated as this project's judgement rather than dressed up as a citation.

  **The objection that does not apply here is written beside the constant**, because it will otherwise be reapplied to the wrong thing. Near-duplicate merging was declined once for `src/research/corroborate.ts` on the grounds that thresholds in this range are tuned against article bodies and would collapse genuine corroboration between one-sentence claims. That is correct, and it is about the input. This scorer is given full page text, which is the case those thresholds were tuned against. The product's own crude claim-text detector is untouched.

  What the number cannot mean is stated with it. A domain with no fetched page, a page too short to characterise and a page past the page ceiling are each counted as their own source and **named**, because a collapsed count that quietly means "we checked some of them" is worse than none. There is deliberately no blended quality score: the prior art is explicit that citation volume and citation quality are close to orthogonal, so blending them hides the failure being measured.

- **The first hand-authored gold sets for the benchmark, under `bench/tasks/`, plus the two scripts that prove them.** Twenty-seven tasks were authored across eight categories, every gold fact anchored on an immutable June or July 2026 event and cited to a publisher's own API. **Seven are admitted. Twenty are quarantined**, and the reason is the finding worth reading.

  `npm run bench:verify` fetches every cited source through the repo's SSRF-safe `safeFetch` and checks that the recorded quote and the recorded value are both really in it: **82 of 82 source checks proven** on 27 July 2026, across the admitted set and the quarantine alike. It reports an unreachable publisher and a body it stopped reading early as different answers from a missing fact, because a 403 says nothing about whether a fact is real and reporting it as a fabrication is the defect the script exists to catch. That distinction was not theoretical: npm's registry document for `typescript` is 15.5 MB, and under the first byte cap the script used, a true gold fact sitting past the cap read exactly like an invented one.

  `npm run bench:failcheck` runs each question through a local coding CLI and reports whether the answers are already there, which is BENCH-09's rule that a task must be shown to fail before it is admitted. Closed-book, with every tool disabled, **0 of 27** were answerable from the model's weights, so the no-training-recall rule holds. With web search on, **23 of 27 were already answered in full by Claude Code, and 20 of those also by Codex.**

  **What that means is that most of the corpus was a lookup rather than a research task.** Anchoring each fact in a single machine-readable primary source at a stable URL made it verifiable and made it trivial: an agent fetches `nodejs.org/dist/index.json` once and reads off four answers. The prior art already names the technique that avoids it, LiveDRBench's problem inversion, and it was not applied. The tasks that survived both backends are the ones whose answer is an **absence** — what a register does *not* publish — which cannot be read off a field. The twenty are kept in `bench/quarantine/` with their verified gold sets and a record of exactly which backend passed what, because the expensive half of the work is the gold set and the cheap half is rewriting the question.

  One tension is recorded rather than resolved: `docs/plan/benchmark.md` makes the free local loop over ordinary web search the benchmark's **control**, and the strictest reading of the fail-first rule excludes every task that control passes, which forces the control to zero and makes the comparison the design exists for impossible. Seven tasks are admitted under the reading that at least one probed backend must not already pass; four survive the stricter reading, and the evidence names which.
- **The benchmark run harness, under `bench/src/run/`.** Executes a matrix of task times backend times repetition and appends one raw record per cell to a JSONL store. Nothing here scores anything and nothing here renders anything. Documented in [`docs/bench/run-harness.md`](docs/bench/run-harness.md).

  Three properties are the whole point. A batch is **planned before it runs**: the plan names the total cells, the cells already recorded, the remainder, and the projected worst case of that remainder, and refuses above the ceiling before a single cell starts, naming the total it needed. `--ceiling` is required, because a batch with no ceiling is the one that quietly buys four figures of research. **Re-running completes exactly the cells with no recorded outcome**, because each cell is persisted before its slot is released, so a process killed mid-batch has every finished cell already on disk. And a **failed cell is recorded with its reason rather than omitted**, since an omitted failure silently improves the backend's score, which is the same defect as a throttled search counting as an established absence. This repo's own ledger is the argument: `local-codex` was 0 for 3 and `openai` 0 for 2, and both would have vanished from a naive average instead of showing up as infrastructure problems.

  Every cell goes through `Runner.start()` and never around it, so dedupe, the concurrency cap, the per-provider budget, the rolling-window budget and the ledger all still apply per cell. Concurrency defaults to 3 and is clamped below `DOSSIER_MAX_CONCURRENT`, so a batch that runs for days cannot take every slot from interactive use.

  **The harness is built rather than adopted, and that reverses a decision made three days earlier.** The plan said to adopt promptfoo as the shell. It was evaluated against the real package first, as the brief required: `promptfoo@0.121.19`, driven on 27 July 2026 with custom providers and a custom assertion. Three of four claims hold, including that a custom scorer really does see the whole report untruncated. The fourth does not. `promptfoo eval --resume` run against a **fully completed** four-cell evaluation printed `Resuming: skipping 4 previously completed cases` and then called the provider four more times, leaving eight rows for a four-cell matrix duplicated on the same coordinates. No process was killed in that control. For a prompt harness that wastes a cheap API call; here a cell is a $1 to $7 research job, so one resume re-buys everything already paid for. promptfoo also has no budget gate and cannot have one at its extension points, since a provider and an assertion are both called per cell after the batch has started. The scorer contract is still adopted exactly (`{ pass, score, reason }` is promptfoo's `GradingResult`, so an assertion is a two-line wrapper), and the dependency is not: it installs 1.6 GB and wants `ai@^6` against this repo's `ai@^7`.

- **A checked file format for benchmark tasks, under `bench/`.** One YAML file per task, parsed into a typed corpus by a loader that is pure and synchronous, so a scorer can be tested without a filesystem. Nothing here scores anything and nothing here touches the network; it is the contract the rest of the benchmark reads. Documented in [`docs/bench/task-format.md`](docs/bench/task-format.md).

  Three behaviours are deliberate and are the opposite of what the server does elsewhere. A malformed task file **fails the whole load**, naming every bad file at once, rather than being skipped the way a bad record in a listing is: a corpus that quietly drops a task reports a score over a sample nobody chose. An unknown or misspelt field is rejected rather than ignored, because a silently dropped line is a task scored on less than its author wrote. And a task that has gone 183 days without human re-verification still loads, but is flagged stale and counted, because gold rots and a score over a corpus that is a third stale is a different claim from one that is not.

  Two rules are enforced by the shape of the schema rather than by a check somebody has to remember: a numeric answer cannot be written without a tolerance, and cannot be written without a unit. Comparing floats exactly is how a correct answer scores zero, and a right figure in the wrong unit can only score zero if the right unit was recorded.

  `bench/` is typechecked, linted, hygiene-checked and unit-tested by `npm run gate`, and is deliberately not compiled into `dist/` or shipped in the package. `npm run build` now clears `dist/` first, so a stale artefact from a hand-run compile cannot ride along in a tarball.

- **Three benchmark scorers, under `bench/src/score/`: calibration, refusal correctness and recency.** Pure synchronous functions over a report's text and a loaded task. No model, no network, no filesystem. Documented in [`docs/bench/scoring.md`](docs/bench/scoring.md). Nothing in the shipped server changes.

  **Calibration** pairs each stated confidence with whether the answer it was about was recovered, and returns a Brier score plus the reliability table underneath it. It is the only measure in the suite that can say a backend right 60% of the time that says High every time is worse than one right 55% whose Highs are right 90%.

  Two decisions in it are worth knowing because they are the difference between measuring something and measuring nothing. A confidence marker is paired to an answer by the answer's **label**, not its value: pairing on the value can only ever match a report that already got the answer right, so the confidently wrong claim, which is the single thing calibration exists to catch, would never be paired and the backend would never be charged for it. And a report that states no confidence anywhere scores **unmeasurable**, never zero, with three distinct reasons. A Brier score of zero is a perfect score, so collapsing unmeasurable onto it does not merely lose a finding, it inverts it.

  **Refusal correctness** grades the false-premise and no-public-footprint families on three outcomes rather than two. A report that pushes back scores full marks even if it says nothing else useful, which is the point of the category rather than a rounding of it. A report that never mentioned the subject is neither a correct refusal nor an asserted fabrication, so it sits between them and carries its raw outcome, letting a reader who wants the stricter rule recompute from a stored cell. A failed refusal stated at High confidence is flagged overconfident, which is DeepTRACE's published dimension adopted rather than a metric invented here.

  **Recency existed in the design as a scored dimension nobody had built.** `docs/plan/benchmark.md` says to weight by source type "using the existing rule that a standard from 2019 is current while a benchmark from 2019 is not", and BENCH-01 verified that rule does not exist: `HORIZONS` in `src/research/evidence.ts` is keyed by source type alone, so a 2019 W3C recommendation and a 2019 leaderboard grade identically. The missing axis is durability, and it is orthogonal to source type: what makes a document age is not who published it but whether it describes something that changes. A benchmark result published by a standards body is still a benchmark result, so the path is checked before the host.

  The product's own `assessStaleness` is deliberately **unchanged**. Adding the axis to it would change what `research_evidence` prints for every user, which is a product decision rather than a benchmark's to take. A parity test drives the product's grading and the benchmark's side by side across every horizon boundary, so a source of unknown durability must grade identically and a future change to either fails loudly.

  Four defects were found by exercising rather than by reading, three of them by an adversarial pass over the finished code. A `<CONFIDENCE:LOW>` tag claimed only its body during overlap resolution, so the labelled pattern re-read `CONFIDENCE:LOW` inside the closing tag and counted every tagged claim twice, doubling the sample any tagged report was scored over. A confidence qualifier written *after* its claim, which is the natural shape in prose and the shape the prompt leaves open, governed an empty span, so the whole trailing half of a report was dropped from the sample and the remaining Brier score was reported as a real number. Acknowledgement wording anywhere in a report excused a paragraph that stated the fabrication as fact, complete with date and venue, and scored it a clean refusal at full marks; the outcome is now decided per paragraph. And `tr`, in the durable-path list for `w3.org/TR/`, is also the ordinary Turkish locale segment, so 2019 news articles were grading current in 2026.
- **The benchmark's due-weight scorers, measuring whether a report kept a genuine dissenting position and whether it invented one.** Three metrics over one report and one task: dissent recall, conflict acknowledgement, and a false-balance guard. Every answer is computed from fields the task author recorded in advance, so no model is called at scoring time. Documented in [`docs/bench/due-weight.md`](docs/bench/due-weight.md).

  **The third metric is the reason the other two mean anything.** Dissent recall and conflict acknowledgement, alone, reward hedging: a backend that presents every question as contested cites every recorded dissent and states every recorded figure, scores perfectly on both, and is useless. The guard is the counterweight, and the aggregation is what makes it bite. Each metric counts once rather than once per task, so ninety contested tasks cannot outvote ten settled ones, and the three are combined by harmonic rather than arithmetic mean. That is not a preference: the arithmetic mean of a perfect hedger's scores, 1.0 and 1.0 and 0.0, is 0.67, which is a passing grade. The harmonic mean of the same three numbers is 0. A fixture runs both backends over a mixed corpus and measures it rather than asserting it.

  **When no task in a set recorded a fringe claim, the headline number is withheld rather than reported with a caveat**, because without the counterweight it rewards indiscriminate hedging, and a caveat printed beside a number is read as a number. The two metrics that could be measured are still reported.

  Every result carries its limits in words, and they travel into the output rather than living only in a document. The sharpest one: a report reaching the dissenting position **in its own words** scores zero recall, because only the literal distinguishing term and the exact cited URL count. That is a floor on what the metric can claim, not a claim about the report, and it is stated as such.

  **Two adversarial reviews, in and out of family, found six defects between them that the tests did not.** Two defeated the metric outright. A single fringe claim could only be recognised by the exact wording the gold set records, which is private to the task author, so a backend that cited the fringe source and paraphrased the claim scored a perfect guard; a claim is now raised by its term **or** by a citation of its source, matching the two doors dissent recall always had. And one debunking sentence laundered every fringe claim within a paragraph, so six documented claims presented as live controversies scored 1.0; a rejection cue is now attributed to the claim it follows, which also keeps crediting a report that dismisses several claims in sequence. Four more: one number stated twice satisfied two overlapping gold values; an empty report scored one overall on a fringe-only corpus; `50%-60%` read as fifty and minus sixty; and a magnitude-suffixed range such as `$1.15bn-1.2bn` silently lost its right-hand figure while the documentation claimed ranges were kept.

  Two constants also turned out to be untested, in the sense that widening them left every test green. Both now fail a test if changed.

  Three things were measured rather than assumed, and each would otherwise have shipped a wrong answer. `canonicaliseUrl` preserves the URL scheme, which is correct for counting independent sources and wrong for deciding whether one document was reached, so the `http`/`https` fold is layered on in the scorer instead of changing product behaviour to make the benchmark's own numbers nicer. Two gold values whose tolerances overlap could both be satisfied by a single stated number, scoring a one-sided report as having disclosed a disagreement it never mentioned; a stated number is now claimed by at most one value. And applying a magnitude word by multiplying floats is off by one unit in the last place often enough to matter (`1.07 * 1e9` is `1070000000.0000001`), so a report stating the gold figure perfectly would fail an exact tolerance; the decimal point is shifted in the digit string instead.

### Fixed

- **The dedupe fingerprint had no repetition index, so a deliberate repeat collapsed onto one paid run.** `FingerprintInput` in `src/research/contract.ts` carried prompt, tier, tools, planning, attachments, provider, shape and window, and nothing that distinguished the second identical request from the first when the second was meant. Inside the dedupe window, five runs of the same question on the same backend were **one purchase returned five times**.

  Nothing user-facing was wrong today, because nothing shipped asked for a repeat. It was about to be: the benchmark's variance measurement runs every task `n` times per backend, and every spread, every `pass^k` and every non-determinism figure would have been computed over a single sample while reporting five. The measurement most sensitive to the defect is the one it makes look cleanest, because five copies of one report have zero variance. Found by BENCH-01's review of the briefs around it rather than by anything failing.

  The fix makes a deliberate repeat **expressible** instead of weakening dedupe. Omitted, or `0`, hashes to the byte-identical value it hashed to before the field existed, so no stored fingerprint is invalidated and no live dedupe window is reopened by upgrading. A fractional, negative or `NaN` index throws rather than being hashed, because every `NaN` stringifies alike and would silently recreate the collapse it was added to prevent. And there is **no nonce anywhere**: an agent stuck in a retry loop passes the same arguments each time, including this one, and still collapses onto the run it already bought, which is the case dedupe exists for. No MCP tool gained an argument; the only caller that needs a deliberate repeat is the in-repo benchmark harness.

  Two defects in the first version of that fix were found by an out-of-family review, and both defeated it. The repetition index was **appended to a space-joined canonical string whose last element is `wideSpec`**, so `wideSpec: "foo"` with repeat 7 hashed identically to `wideSpec: "foo repeat:7"` with no repeat, and a caller could collide a deliberate purchase onto an ordinary one. The reviewer demonstrated it rather than reasoning about it. A repeat is now hashed in a second round over the first digest, whose input is always 64 hex characters, so nothing user-controlled can reach it. And the runner threaded the index with a **truthiness test**, which drops `NaN`, so a malformed index skipped the guard that exists to reject it and deduped onto the no-repeat run. It is now passed through on presence and the fingerprint refuses it.

- **Every `local-codex` run had been dying at argument parsing, and nothing could see it.** The adapter sent `codex exec --search`. `--search` is a flag on `codex` and not on `codex exec`: it is documented on `codex --help`, absent from `codex exec --help`, and `codex exec --search` answers `error: unexpected argument '--search' found` and exits 2 before doing anything. So no research ever ran on that backend, and because a CLI run is ledgered at $0 it cost nothing visible while silently consuming a seat on every panel it joined. Verified by hand against codex-cli 0.145.0 on 27 July 2026.

  Setting `web_search = "live"` in `~/.codex/config.toml` is **not** a workaround, because the invocation dies at argument parsing before config is ever read.

  The fix is the bare positional, `codex exec <brief>`. `-c web_search=live` is deliberately not sent: it is accepted and recognised on this build, and it is not what turns search on. That was measured rather than assumed, by asking for the current top three Hacker News titles with shell, curl and bash forbidden, a fact that turns over hourly and no local command can reach. Plain `codex exec` returned all three in order, exactly matching the Firebase API ground truth, so web search is already on by default in `exec`. The first attempt at this measurement asked for an npm package's latest version and is the more instructive half: the control arm answered correctly and proved nothing, because Codex has shell access and could simply have run `npm view`. Adding a config key that does nothing would buy the same class of failure as the bug being fixed, at config load, on a path an offline argv check cannot see.

  **Version-aware by probing, not by comparing version numbers.** An older Codex may genuinely take `--search` on `exec`, and a version comparison encodes a belief about which builds changed their flags that is wrong the moment a vendor backports or a user pins. So Dossier runs `codex exec --help` on the actual binary and uses the form that binary documents. The answer is cached in memory keyed by resolved absolute path, because two Codex installs on one machine can differ and the name on PATH does not distinguish them. Not persisted, unlike the probed-model cache: that one persists because its probe costs a paid model round trip, while this is an offline `--help` taking milliseconds, and a file would add nothing except the risk of answering from a stale reading after an in-place upgrade.

- **`research_doctor` could not detect that class of failure at all.** It reported Codex as CONFIGURED, UNVERIFIED on the strength of a `--version` probe and a sign-in file, neither of which touches the invocation that actually carries the brief.

  It now runs a **parse-only self-test per adapter**: the real headless argv, with the brief replaced by an inert token and `--help` appended, run against the binary. The flags are parsed, then the process prints its help and exits without reaching a model. Offline, free, milliseconds, and it would have caught this bug with no network call and no cost. A refusal is reported as a defect in Dossier rather than in the user's setup, and names the `DOSSIER_PROVIDERS` id to exclude in the meantime.

  It runs on the default path, under the existing `probeLocal` flag rather than a new one. It does spawn a process per identified CLI, which is the argument for a flag, and the argument loses: `probeLocal` already runs `--version` on every one of them, and putting the one check that finds this class of bug behind an option nobody sets is how the bug survived in the first place. A non-zero exit with no argument-parse signature is reported `INCONCLUSIVE`, never `REJECTED`, because a binary that merely wants a login is not a broken adapter and accusing it would send a bug report to the wrong person. The check covers argument parsing only, and says so: a value the binary accepts as an argument and rejects later while loading config would still pass.

- **A rate-limited paid call was treated as unretryable, which cost $18 for want of about a second.** Two OpenAI runs failed with HTTP 429, both naming their own wait: `Limit 1000000, Used 923902, Requested 96709. Please try again in 1.236s.` and the same again at 4.606s. Both were reported as hard failures and both had already reserved $9.

  `attemptOnceThenSettle` exists because a create that timed out **after** the provider accepted it has already bought the report, so a retry buys a second. That reasoning is correct and the rule was too coarse: it conflated a request whose outcome is *unknown* with one the provider *definitively refused*. A 429 is a rate limiter answering, and a limiter that answers has not queued the job.

  Retrying now happens on a 429 only, honouring `Retry-After` where the provider sends one and the delay named in the message where it does not, bounded by attempt count, by a total-delay ceiling and by the caller's deadline. Everything ambiguous is unchanged and is never retried. The statuses treated as definitive rejections are exactly 400, 401, 403 and 429, enumerated in the code with the reasoning for each, because getting that list wrong in the other direction buys a second report. Not 404, not 409, not 422, not any 5xx: some of those very likely created nothing either, but "very likely" is the wrong standard when being wrong releases money against a report that was really bought.

  Related, and found on the way: an HTTP status carried only on a wrapped error's `cause` was invisible to the classifier, so a Gemini 429 wrapped in `GeminiRequestError` was classified `fatal` and never backed off at all. The status is now unwrapped through the cause chain.

- **A definitively-rejected run held its budget commitment against a call that never reached a model.** The ledger is written before the API call on purpose, so a crash over-counts rather than under-counts, and that default is unchanged. But the owner's ceiling was reduced by $18 for two requests that were refused in about a second each.

  A 429, 400, 401 or 403 now releases the commitment. **Only** those, and never an ambiguous failure, where holding it is still the safe direction. The release is a compensating `release` line appended to the ledger, naming the same run: history is never mutated, so the record still says that Dossier reserved and then learned better. A release can only ever give back what its own run reserved, which is why it is a separate line kind rather than a negative amount; a negative amount would be the smaller change and would hand anyone who can write to the ledger an unlimited budget in one hand-edited line.

- **An argument-parse failure and a research failure were indistinguishable.** Both rendered as the single word `failed` in the run list, so an adapter that could never have worked sat beside a genuinely hard question looking identical. They need opposite responses: one is a bug report, the other is a re-scope.

  Every failed run now carries a kind, shown in `research_list`, in `research_status` and in a panel's roll-call: `BROKEN ADAPTER`, `rate-limited`, `rejected by provider`, `outcome unknown`, or `research failed`. A backend that refused the invocation is called out in the listing as a defect in Dossier rather than in the user's setup. A run recorded before this existed carries no kind and reads exactly as it always did, rather than being labelled with a guess.

- **The upstream provider error was stored and never shown.** It was on the run record all along, which is how these 429s were diagnosed at all, but nothing surfaced it where a person looking at a failed run would see it, so a quota problem, an entitlement problem and a request-shape problem all read as the same unexplained failure. The provider's own text now appears verbatim in `research_list` and in full in `research_status`, with the HTTP status beside it, and a 429 is labelled as rate limiting rather than left to be inferred.

- **A panel did not report which members actually contributed.** The merge note only ever described the members that finished, so a member failing silently inflated the apparent breadth of the whole panel: four members returning one report read exactly like four-way coverage. The note now opens with a roll-call, how many members produced a report and then every member by name with its size and source count or its state and failure kind, and warns explicitly when fewer contributed than were paid for.

- **Three gaps left open by the model-probe change.** The CLI preference order put Cursor ahead of Grok, so a Cursor pointed at Grok 4.5 would have kept its seat and evicted xAI's own CLI; `grok` now sorts first, because it is first-party for those weights and a capability xAI adds later arrives there first. A probed reading is now trusted for 30 days rather than forever: past that it is still shown with its age but no longer removes a backend, since a CLI can change model in a release and a stale dedupe fails invisibly while a stale label costs one line of text. And `research_doctor` is documented in `docs/tools.md` for the first time, including why it is annotated `readOnlyHint: false` when its default invocation reads nothing and spends nothing.


### Changed

- **A cheap backend now joins a panel on measured coverage, not only on the question profile.** A real seven-backend run returned 133 sources across 30 registrable domains at 4% overlap, so the backends were reading substantially different material rather than repeating each other. The original rules assumed the opposite and kept backends out unless the question specifically called for them. At xAI's price, exclusion was the expensive choice.

  This rests on one observation and is recorded as resting on one. It was acted on because the effect was large, one-directional, and cheap to be wrong about. Price still gates the lane: a $9 backend still needs a reason, or the cost band stops meaning anything and the panel becomes every configured backend wearing a justification. OpenAI additionally joins technical questions, where its reading of issue trackers and changelogs differs from the others.


### Fixed

- **The cross-backend merge reported zero agreement whatever the backends actually agreed on.** Claims were matched by wording: lowercased, punctuation stripped, first 120 characters compared. Five backends never phrase a conclusion identically, so the count was structurally always zero, and the zero was then rendered as "No claim was made by more than one backend. That is itself a finding: these reports do not overlap." That is a confident negative produced by a test with no power to find a positive, which is the failure this whole product argues against, in its own output. Found by an owner reading a real panel result where four of five backends had plainly reached the same four conclusions.

  Convergence is now found by what a claim is *about*. Salient tokens (numbers and content words, lightly stemmed so "fine-tuning" meets "fine-tune", hyphens split so "from-scratch" meets "from scratch") are compared with a Jaccard weighted by how rare each token is across the claim set. Rarity is what makes it work: two backends sharing "0.6B" and "decoder" have said something, two sharing "model" have not, and plain Jaccard cannot tell those apart. On the real claims that prompted this, plain Jaccard scored 0.30 and would have needed a threshold low enough to admit anything; weighted, the true pair scores 0.21 while an unrelated claim never joins at any threshold down to 0.10.

  It is reported as a candidate list, never a verdict, and always with the overlap score and the shared terms visible so a reader can reject a pairing. Raising it to an assertion would trade a false negative for a false positive, and an overstated convergence is the worse of the two: it is the corroboration trap reached by arithmetic instead of by credulity. The wording-match count survives alongside it, renamed to say what it measures.


- **The panel's free lane could seat two CLIs serving the same model and report them as two independent backends.** The lane's whole justification is that different models drive different searches and therefore read different parts of the web; that is why running four subscriptions beats running one. Two CLIs on one model are one perspective, so the panel bought one and reported two, and the automatic merge then flagged an overlap the panel had created itself. The corroboration trap, living inside the lane built to prevent it.

  It is a real configuration rather than a hypothetical: Cursor lets you point `cursor-agent` at Grok 4.5, and nothing about a binary's name or version string would ever reveal it.

  **Where two free-lane CLIs are known to serve the same model, one joins.** The survivor is the earlier one in the existing preference order; the other appears under **Not on the panel** with the model they share, both spellings of it, and the age of the reading behind the decision.

  **Known, never guessed.** Dossier will not infer a model from a product name. Probed on the owner's machine on 27 July 2026, `cursor-agent` answers `Composer` and `grok` answers `Grok 4.5`, so on a default install the four CLIs really are four models and a guess would have dropped a paid-for backend for nothing. On a machine that has never been probed, every CLI keeps its seat and the panel says plainly that the lane may hold the same model twice and how to check.

- **A capability is never inherited from a probed model, and the reasoning is now written down where someone would go to change it.** Point Cursor at Grok 4.5 and that member still has no X access: live X search is a first-party tool xAI attaches to its own API, not something the weights carry with them. Capability declarations stay per CLI.

  `socialSources: []` on every CLI backend was confirmed by testing rather than by reasoning, and the finding is recorded in the code so it is not "fixed" back. Asked for a real x.com post URL, both `grok` and `cursor-agent` produced one, which only proves an ordinary web search reached an indexed x.com page. The discriminating test is recency, which only a live firehose can serve: asked for a post from the last three hours, both answered that they could not, and the Grok CLI announced it would sort by recency before failing to.

### Added

- **`research_doctor` takes `probeModels`, off by default, which asks each signed-in CLI which model it actually serves.** It sends one short question to each identified, signed-in CLI and caches the answer under the store directory with a timestamp, so it is asked once rather than on every detection. Every reading is printed with its age, because a model identity is a fact about a setting you can change whenever you like.

  It is opt-in for a reason. Ordinary detection is sync, offline and free, which is what lets it run on every routing decision; this spends a model round trip against each of those CLI subscriptions and takes a few seconds each. It refuses to prompt a binary it could not identify or a CLI nobody has signed into, on the same rule that governs a research run: an unidentified binary is never handed a prompt.

### Changed

- **`research_doctor` is no longer annotated `readOnlyHint: true`.** It can now invoke a model, when `probeModels` is true, and the annotation describes the tool rather than one argument value. A default call still spends nothing and makes no network calls of its own. Clients that auto-approve read-only tools may now prompt for it.

## [0.8.0] - 2026-07-27

### Fixed

- **Em dashes are gone from every string a user can see.** 146 of them across 13 files, in tool output, error messages and prompts. The 67 in code comments are left alone, because rewriting internal prose mechanically risks mangling meaning for no reader's benefit.

  The sweep broke something on the way through, which is worth recording. `DECLARED_GAP` in `src/research/shapes.ts` matches an em dash on purpose: a table cell containing one is how a model most often writes "there is nothing here", and treating it as a declared gap rather than as content is the difference between an honest empty cell and a silent hole. A blanket replacement turned it into a comma, and all 631 tests stayed green. It is restored, the regex now says in a comment that it is data being parsed rather than prose being written, and there is a test over every gap spelling that would have caught it.


### Added

- **`research_start` without a `provider` now assembles a panel instead of picking one backend.** One brief goes to every backend that belongs on the question, in three lanes. Lane 1 is free: every coding CLI that is installed, signed in and capable of the shape you asked for. It is the floor, and it runs with no API keys configured at all. Lane 2 is paid, and an API backend joins only when a key exists *and* the question calls for what that backend is distinctively good at. Lane 3 is a crawl, and the panel can only ever recommend one: Mode B stays behind `DOSSIER_BROWSER_PROVIDER` and Dossier drives no browser.

  **Capability is screened before billing and before the profile.** A backend that cannot enforce a date window does not join a date-bound panel merely because it is free. This is the same rule that has governed single-provider routing since 0.5.1, applied to the panel by sharing the same screening pass rather than by reimplementing it.

  Membership is driven by a **question profile** read off the question on top of the existing archetype classifier: enumeration, time bound, social, primary literature, named sites, legal or regulatory, breadth. Signals are additive, so a question that is both time-bound and legal gets the backend each one implies. The profile is keyword and archetype work only, with no model call, because it runs inside `research_plan` and `research_plan` is free.

  Two judgements are deliberate and not derived from the signals. Gemini and Perplexity lean towards joining whenever a key exists, Gemini because it is the most comprehensive backend available and Perplexity because at roughly $0.29 a measured run it is cheap enough that omitting it rarely saves anything worth having. And xAI is never the only backend concluding on a legal or regulatory question, because its own documentation describes it as suited to finding things rather than to concluding them. Naming it explicitly in `DOSSIER_PROVIDERS` overrides that, because an instruction outranks a guard whose job is to second-guess an automatic choice.

  **A panel reserves the sum of its members' worst cases before any member starts, not member by member as it goes.** A panel that cannot be afforded in full starts nothing at all, writes no ledger line, and reports the whole figure it needed rather than the amount by which the next member missed. Half a panel is a worse answer than one good backend and it has already spent money to be worse. The same rule covers concurrency: a panel of five needs five slots at once and is refused whole.

  **A panel of one is a legitimate outcome** and is reported as a result rather than as a fallback.

  Each member is its own run, bound by a shared panel id, so `research_status`, `research_read`, `research_tail` and `research_budget` work per member with no change. A member that deduplicates onto an identical existing run is handed it and is not charged again while the rest still start; a member that refuses at create time is reported without stranding the members already billed. Every member is attempted once, through the same `attemptOnceThenSettle` path as a single run.

  **`research_plan` now prints the panel** member by member with a cost against each, free lane separately from paid, with a total and the question profile, before the contract fingerprint is issued. It names every configured backend it left out and why. The fingerprint binds the whole membership, so a plan for a three-backend panel will not start a two-backend one.

  **When every member reaches a terminal state the panel is merged automatically** with `research_synthesise`'s free deterministic pass, and the result is written to every member's journal. The overlap warning matters more here, not less: five backends that read the same ten pages is the corroboration trap at five times the price, and it now surfaces at the moment the panel finishes rather than when someone remembers to ask. Agreement between members is still not corroboration, and support is still counted in independent registrable domains.

  Naming a `provider` is unchanged in every respect and still starts exactly one run on exactly the path it always took, with no panel id.

- **Every signed-in coding CLI now answers, rather than the best one of them.** Each CLI is its own backend with its own id: `local-claude`, `local-codex`, `local-grok`, `local-cursor`, `local-agy` and `local-gemini`, derived from the adapter table so adding a CLI later does not mean editing three files. On a machine with Claude Code, Codex and Grok all installed and signed in, the free lane of a panel is three members, three runs and three ledger lines at $0, ordered strongest first.

  This was the shortfall in the panel work above. A panel assembled on that machine produced a free lane of **one**, because `ProviderId` admitted a single `local` id and the local adapter chose one CLI by preference order before the panel ever saw the rest. Two of three paid-for subscriptions sat idle on every run, which is the exact waste the panel was built to end.

  Each CLI now carries its own label, its own model choice and its own detection, so a CLI that is installed but not signed in loses its own seat and does not disqualify the lane. Ledger lines at $0 are written and kept, because the ledger is the record of what ran and not only of what cost money. Three CLIs on one question are three distinct dedupe fingerprints, since the fingerprint includes the provider, so they do not collapse onto one answer.

  Records and ledger lines written before this change carry `provider: "local"`. That id is kept in the schema and still parses, and `local` still resolves to a working backend, so nothing already on disk becomes unreadable. `DOSSIER_PROVIDERS` accepts the new ids, and `local` in it is an umbrella for every one of them.

### Changed

- **`DOSSIER_LOCAL_CLI` restricts the free lane instead of selecting the CLI.** Set it to a CLI id and the free lane holds only that CLI, however many others are installed and signed in. Unset, which is now the default, every capable signed-in CLI joins. The variable keeps its purpose as an operator override without contradicting the panel.

### Fixed

- **Setup wrote `DOSSIER_LOCAL_CLI` whenever any subscription was picked, which would now silently narrow the free lane to one CLI.** It wrote the first of the operator's picks. Under the old meaning that chose a CLI, which was harmless; under the new one it leaves every other subscription the operator had just told us about idle on every run. Setup now writes the variable only when exactly one CLI was picked, which is a deliberate choice of that one, and writes nothing when several were picked so all of them join.

## [0.7.0] - 2026-07-26

### Added

- **The free local loop now runs as a lead with workers, and the lead does not read search results.** `research_local_start` returns a dispatch plan rather than a flat task list: one worker per task, each doing its own searching and handing back at most ten one-sentence findings. The cap is in the schema, not in the prose, because a worker that returns everything it saw has moved the sifting to the lead, which is the job it was dispatched to do. The lead drafts from the registry plus the deep-read notes the workers send back, and never goes near a result page.

  This is the change that makes a long run finish. Raw listings are the bulk of what a search returns and almost none of it is evidence; a lead that reads them spends its context on snippets and has none left for the report, which is how a run with good sources still produces a shallow synthesis.

  **Tasks now come back in dependency groups.** Group A is independent and source-diverse and goes out in parallel, at most three at a time. Group B is a single reconciliation task that reads what group A found and searches the disagreements rather than the subject. `research_local_note` refuses a group B report while its dependencies are outstanding, and hands the registry over the moment the last group A task lands. Reconciliation is skipped below three group A tasks and in `light` mode, because there is nothing to reconcile across two sources.

  **`research_local_note` now takes `gaps` and `deepReadNotes`, and an empty `findings` array is legitimate when `gaps` says what was searched and not found.** A task that establishes there is nothing there has produced a real result about the public record, and it used to be indistinguishable from a task that crashed. Draft time now keeps three outcomes apart that used to look alike: a task that never reported (a coverage gap), a task that ran and found nothing (an established negative), and a source refused after the freeze.

  **`have` declares what your client can actually do**, and the loop degrades out loud. No web search halts the run before a session is opened, because a loop that continued would write a fluent report from the model's own memory with citations attached. No page fetch forces every task to scan depth, including the reconciliation task, which asks for a deep read by default and would otherwise keep telling a worker to open pages on a host with no way to open one. No subagents means sequential; no filesystem means report as you go. Each degradation prints what it costs. Capabilities are declared rather than probed because a stdio server cannot see its client's tools, and a guess would be wrong in the direction that matters.

  **`asOf` and `mode`.** Every session carries an as-of date, and at freeze time anything stale, undated or dated after the horizon is listed with a rule to downgrade what rests on it. Recency is judged by source type: a standard from 2019 is current, a benchmark from 2019 is not. `mode: 'light'` lowers the evidence floors to 6 sources across 3 domains for a narrow single-entity question, because holding a small question to the large floors fails it for being proportionate and teaches people to ignore the gates.

  **When every task ran and the registry is still empty, `research_local_draft` returns the failed checks, `Confidence: N/A` and a recommendation to contact the subject directly**, instead of drafting rules. Handing back drafting rules there is an invitation to write a report about a subject on which nothing was found.

  The structure is adapted from [daymade's deep-research skill](https://github.com/daymade/claude-code-skills). Dossier keeps its own counter-review rule rather than the skill's: coverage is required and an issue quota is not, because demanding a minimum number of objections rewards inventing them. Enterprise mode is deliberately not implemented.

- **`research_local_note` now records what actually happened when a task searched, and a failed search no longer counts as an established negative.** The new `outcome` says whether the search completed: `ok`, `no-results` for a clean search of a healthy index that turned up nothing, and `rate-limited`, `blocked` or `tool-failed` for a search that never finished.

  The boolean this replaces was wrong, and had shipped. Any empty report was recorded as having found nothing, so a worker whose search tool was throttled looked identical to one that queried the index properly and established the absence. When every task came back empty, the run rendered the black box: "unable to verify anything about this subject from public sources", `Confidence: N/A`, contact them directly. That is an assertion about the world, and it was being made on the strength of four searches that never ran. It is the exact failure the black box was built to prevent, arriving through the back door.

  Draft time now keeps four outcomes apart rather than three, and the black box requires that every task completed cleanly. A run with a failed search gets a warning naming the task, its source class, and why its absence proves nothing, with an instruction not to write it up as a negative and to rerun it if the answer turns on it. `no-results` alongside a non-empty finding list is refused at the boundary, because whichever was meant the other is wrong and only the worker knows which. A findings-then-throttled task keeps its findings and is still counted as incomplete coverage.

  Adapted from `last30days-skill`'s per-source status vocabulary and its rule that a failure state is never evidence a source had nothing. Ten states collapse to five because Dossier's reporter is a model driving a search tool rather than an HTTP client, and a state nobody can report accurately is a state that gets guessed. `docs/plan/external-skill-gap-analysis.md` records what else was read across two external research skills, what turned out to be already present under another name, and what was declined.

- **`research_doctor` now reports the browser tooling on your machine**, and the setup wizard stops offering you an install for a driver you already have. Playwright, browser-use, `chrome-devtools-mcp` and `@playwright/mcp`, in the same section as the coding CLIs and under the same rule: an unidentified binary is reported `ambiguous` and nothing is run.

  **Detection is not permission**, and every reported entry says so. Mode B automation stays behind `DOSSIER_BROWSER_PROVIDER`, Dossier still has no browser of its own, and it still will never type a password. Finding a driver changes nothing about what runs.

  The four tools get two different probes because they are two different kinds of thing, and two of the rules make the weaker-looking probe the correct one.

  **`npx` is never invoked.** `npx chrome-devtools-mcp@latest --version` on a machine without the package downloads it from the registry and executes it, so a detector that asked would answer its own question by making it true. Presence is established by looking for the package directory and never opening it. A test puts a marker-writing fake `npx` and `npm` on `PATH` during a full probe and fails if either is ever called.

  **Your client's MCP config is never read.** Whether a server is registered with Claude Code, Cursor or VS Code lives in that client's own config file, next to every other server's `env` block, and those blocks routinely hold API keys. Registration is therefore reported `unknown`, permanently, and you are pointed at your client to check.

  Nothing reports whether you are signed in. A coding CLI has a session file whose existence can be checked without opening it; a browser driver has no equivalent, because the session belongs to Chrome and finding it would mean walking a browser profile and its cookie store.

### Changed

- **A coding CLI you have already paid for is now preferred over a metered API balance.** If a supported CLI is installed, signed in, and capable of the job, it runs it. A paid backend runs only when the CLI cannot do the work or is not there.

  This reverses the previous rule, at the project owner's direction. Until now the CLI backend was excluded from automatic selection entirely: it costs $0, so any cost tie-break picks it every time, and it draws on a subscription quota Dossier can neither see nor meter while running a third-party binary on your machine. **Every one of those facts still holds.** What changed is the judgement about which default serves the person paying. Billing an API when a capable CLI is sitting there signed in spends real money to avoid spending an allowance already bought.

  Three things keep it honest.

  **Capability still decides first, and this did not touch it.** A CLI cannot enforce a date window, reach X, filter domains or offer an editable plan, so those jobs still route to the backend that can. Preference only ever chooses between backends that can all do the work.

  **Sign-in is required, and it is established by the existence of a session file, never by opening one.** A CLI on `PATH` that nobody has signed into is now rejected outright with `installed but not signed in, so it cannot run`, rather than quietly winning on price and then failing at spawn.

  **The routing reason says what is being spent.** It states that a subscription quota is going rather than an API balance, and that Dossier cannot meter that quota. The word "free" is never used, and a test enforces its absence.

  `DOSSIER_PROVIDERS` still overrides in both directions: name the CLI to force it, or leave it out of a non-empty list to remove it from the registry entirely. `DOSSIER_LOCAL_CLI` still picks which CLI when several are on `PATH`. Identity is still confirmed at spawn by resolving the binary and checking its version string, not at routing time.

### Fixed

- **`research_plan` reported the routed backend even when you asked for a specific one.** `research_start` honoured `provider` correctly and the contract fingerprint included it, but the plan's own **Backend** line came from a second routing call that ignored the argument. So asking for Gemini and being shown xAI made the override look broken, in the one tool whose entire job is to tell you what the run will do before it spends. Reported by a user against 0.6.0.


## [0.6.0] - 2026-07-26

### Added

- **A guided setup, in one command:** `npx -y dossier-research-mcp@latest setup`.

  It reads what is already on the machine, offers the coding CLIs by the subscription that pays for them (Claude Pro, ChatGPT Plus, SuperGrok or X Premium+, Cursor, and Google's free Antigravity tier), installs and signs into the ones you pick, and only then asks about API keys. The default is one paid backend rather than four, and doing nothing at all is offered before either.

  Each provider comes with what it costs per run, what only it can do, and the parts of its console that are not just copying a key: Gemini's $10 minimum prepay and soft spend cap, OpenAI's per-project model allow-list, and the fact that a Perplexity, ChatGPT or SuperGrok subscription does **not** include API access.

  Nothing is installed, signed into, or charged without an explicit yes, and every command is printed before it runs. Sign-in is always handed to the human: the wizard never types a password.


## [0.5.0] - 2026-07-26

### Added

- **`research_synthesise`** merges two or more completed runs into one evidence base and distils a single report. Different from `research_compare`, which diffs what backends claim and leaves you holding two reports. The merge is deterministic and free: deduplicate by canonical URL, count **independent registrable domains**, profile the sources, and record which run found what. The distillation goes to a model if one is configured and to the caller otherwise.
- **`research_export`** writes a full report, plus its numbered source registry, into a directory you name. The markdown carries a front-matter block recording the backend, the model, the tier, the source count, the tools used and the estimated cost, so the file stays attributable after it lands in a repo.
- **`model`** on the run record, populated by every backend at start rather than at completion, so a run that fails halfway is still attributable.

### Changed

- **Routing no longer hard-prefers Gemini.** Ordinary deep runs now go to the cheapest capable backend, which is what `docs/plan/multi-provider-research.md` specified all along: capability, then cost, then dated accuracy as weak evidence, then diversity. Capability still forces the choice where only one backend qualifies, so asking for an editable plan still routes to Gemini and asking for X still routes to xAI.
- **Every `research_read` and `research_status` now shows where the full report is and what produced it.** The absolute path, the backend, the model, the tier, the source count, the tools used and the estimated cost.

### Fixed

- Four consecutive real runs all went to Gemini while three other configured backends sat idle. Routing preferred Gemini for any `deep` run regardless of price, which is a defensible tie-break and was not written as one.
- A caller could read an outline of a 48,000-character report without ever learning the report existed on disk. `reportPath` had been recorded since the first release and was never surfaced by any tool; `toolsUsed` and `sourceCount` likewise.
- Merging several runs from the **same** backend collapsed them into one label, so every source read as unique and the overlap reported 0% however much the runs shared. Provenance now keys on the run. Found by running the merge against four real reports rather than by reasoning about it.

## [0.4.0] - 2026-07-26

### Added

- **Both checking tools now run without a key.** `research_verify_claims` takes claims, returns each cited page's text, and accepts your verdicts. `research_counter_review` hands over four lens briefs and accepts your findings. A configured utility model still does either end to end.

  What stays server-side is what only a server can do: SSRF-checked fetching, holding the sample, and enforcing the rules. **A verdict on a claim that was never fetched is discarded**, and a lens that was never applied is named rather than counted as one that found nothing. The coverage rule lives in one renderer shared by both modes.

### Changed

- The only remaining reason to add an API key is a long unattended investigation: forty minutes across a hundred sources, running while the laptop is shut. Everything else is now a choice about who does the reading. The README and `docs/tools.md` say so.

## [0.3.1] - 2026-07-25

### Changed

- README rewritten for what 0.3.0 actually shipped, and every config key documented.

## [0.3.0] - 2026-07-25

### Added

- **Three more backends.** Perplexity (`sonar-deep-research`, enforced date and domain filters, native wide research), OpenAI (`gpt-5.6-terra` / `-sol`, a 100-domain filter, the largest of the four), and xAI (`grok-4.3` / `4.5`, the only backend that reaches X).
- **Capability-first routing** that names its reasoning, its runner-up, and why each rejected backend could not run.
- **Research shapes** beyond one-question-one-essay: `research_wide` (entity × field matrix with a completion gate), `research_recent` (time-windowed), `research_compare` (one brief on several backends, claims diffed).
- **Evidence governance**: source classification, advisory quality floors, a frozen citation registry, synthesis markers, and a four-lens counter-review that reports four empty lenses as a failed review rather than a clean bill of health.
- **The free tiers.** A local loop the host drives with its own web search, `provider: "local"` for a coding CLI you already pay for, and `research_import` for a report you ran on a subscription.
- **Cross-backend corroboration counted in independent registrable domains**, never in how many backends agreed.

### Fixed

Four defects that a full hermetic suite passed and one real API call each found. Vendor documentation described none of them correctly:

- Perplexity returns `COMPLETED` in **upper case**, against its own documentation. A case-sensitive terminal check meant a finished run was never recognised as finished: it polled until the watchdog gave up and the paid-for report was never stored.
- Perplexity, OpenAI and xAI all return citations **out of band**, in a sibling array rather than in the report body, so fully cited reports were stored with zero sources.
- xAI accepts a `deferred` flag and **ignores it**. Its runs are synchronous, and the capability record claimed they were durable.
- **A call that spends money was being retried four times.** `src/net/retry.ts` opened by stating the rule that paid creation is never retried and naming the mechanism that enforced it, and that mechanism had never been written. A create that times out after the provider accepted it has already bought the report; retrying buys a second.

### Security

- Lock ownership, regex hardening, symlink resolution, prompt-injection and SSRF findings closed. The admission lock is written under a temp name and `link`ed into place: `open(path, 'wx')` is atomic but the holder record is a second syscall, and a contender reading the file in between broke a live lock, letting two processes into the spend gate. It failed roughly one run in three under contention.

## [0.2.1] - 2026-07-24

### Fixed

- Exported the library surface the README already documented.

## [0.2.0] - 2026-07-24

### Added

- Live progress streaming, an acceptance suite that drives the real MCP protocol over stdio, and a paid test project.

### Fixed

- Store schema guarded against a silent upgrade migration; spend gate hardened.
- Corrected the Vertex story: an ordinary API key is the **fuller** backend, not the lesser one, which surprises most people.

## [0.1.0] - 2026-07-23

### Added

- First release. Gemini Deep Research wrapped so an agent can drive it safely: durable runs that survive a disconnect, a spend gate that reserves the worst case before the call, and outline-first reading so a 60,000-token report never lands inline.

[Unreleased]: https://github.com/fledgeling-co/dossier-research-mcp/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/fledgeling-co/dossier-research-mcp/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/fledgeling-co/dossier-research-mcp/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/fledgeling-co/dossier-research-mcp/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/fledgeling-co/dossier-research-mcp/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/fledgeling-co/dossier-research-mcp/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/fledgeling-co/dossier-research-mcp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/fledgeling-co/dossier-research-mcp/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/fledgeling-co/dossier-research-mcp/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/fledgeling-co/dossier-research-mcp/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/fledgeling-co/dossier-research-mcp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/fledgeling-co/dossier-research-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/fledgeling-co/dossier-research-mcp/releases/tag/v0.1.0
