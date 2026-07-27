# Changelog

Every release that changed what the server does, what it costs, or what it needs to run.

Dates are the release date. Costs are estimate bands, never quotes. Where a fact was learned from a live API call rather than from vendor documentation, it says so, because that distinction turned out to matter more than once.

This project follows [semantic versioning](https://semver.org/). Until 1.0 the minor number carries breaking changes.

## [Unreleased]

### Fixed

- **A source dated after the as-of date was graded fresh if it was less than half a day after it.** `assessStaleness` compared a rounded day count, and `Math.round(-0.4)` is `-0` while `-0 < 0` is false, so the `after-horizon` branch never fired inside twelve hours. A back-dated source or a transcription error in that window was silently accepted as current, which is precisely the case that branch exists to catch. It now compares the timestamps. Found by BENCH-06 while building the benchmark's own copy of the rule, which is the argument for building a second implementation and diffing it against the first.


## [0.9.0] - 2026-07-27

### Fixed

- **A failed CLI now says why it failed.** The error read `the CLI exited with code 1` and stopped there, while the reason sat in the CLI's own captured output the whole time. Reported from a real panel where Claude Code failed twice with a bare code 1; the actual cause was an exhausted subscription, and a bare exit code makes that look like a broken adapter. The tail of the output now travels with the error, the tail rather than the head because a CLI that fails partway writes progress first and the error last.

- **A `--version` probe that timed out was reported as a binary that could not be identified.** Those are different findings and only one of them is the operator's problem. Under heavy local load a healthy CLI can miss the probe deadline, and `identity is unconfirmed` sends somebody to reinstall a tool that was never broken. A timeout now says it was a timeout, names the deadline, and says to re-run when the load drops.

- **The gate linted other branches' worktrees.** `.worktrees/` holds git worktrees of this same repository, so a half-written file on another branch failed the main tree's lint. Each worktree runs its own gate against its own branch; the main one no longer runs theirs.


### Added

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

### Fixed

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

[Unreleased]: https://github.com/fledgeling-co/dossier-research-mcp/compare/v0.9.0...HEAD
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
