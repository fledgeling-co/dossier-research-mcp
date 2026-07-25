<div align="center">

# The failure mode of AI research moved, and nobody updated the tooling

**Everyone built defences against made-up citations.<br>Then the tools stopped making up citations, and started getting the arithmetic wrong instead.**

<sub>Luke Rhodes · 25 July 2026, updated 26 July · ~12 min read</sub>

</div>

---

In March 2025, a researcher at MIT Sloan put ChatGPT's Deep Research through its paces. On one task it returned a sixteen-page teaching case study citing twenty-two sources, in about six minutes. On another it cited a paper by "Kumar and colleagues (2024)" showing that repeated AI use reduces later creative originality. That paper does not exist. It reads beautifully.

And it wasn't a one-off. A 2024 analysis in JMIR put reference-hallucination rates for systematic-review citations at **28.6% for GPT-4 and 39.6% for GPT-3.5**. Roughly a third of generated references pointed at nothing.

That's the story everyone internalised, and it's why every AI research tool now ships with a citation-checking story. Dossier, the thing I built and am about to tell you about, does exactly this: it dereferences every cited URL, follows the redirects safely, and tells you which ones actually resolve.

Here's the uncomfortable part. That defence is now largely aimed at a problem the frontier tools have mostly stopped having.

## What the reviews actually found

I went back through fourteen months of deep-research evaluations recently, partly out of curiosity and partly because I was designing a router and wanted to know which backend to send what to. The pattern that came out was not the one I expected.

Sarah Constantin ran five tools against an identical medical-literature question in March 2025 and graded them properly, counting sources and checking the data. Her finding on hallucination: none of them had "a problem with overt hallucination." Not one. What they had was a *scope* problem, all capped around forty sources, and a *sourcing* problem, reaching for WebMD instead of papers.

Then in May 2026, LivePlan's COO ran two real research jobs through ChatGPT and Gemini and fact-checked both reports line by line. No errors. He called it "a major improvement for AI chatbots," and he's right.

Then he found this. Gemini had correctly established the number of US businesses in a revenue band. It had correctly established QuickBooks' market share. And it had correctly established that only about half those businesses use accounting software at all. Then it multiplied the first two numbers together and ignored the third, producing a market estimate inflated by roughly double.

Every fact was right. Every citation resolved. The conclusion was wrong.

You cannot catch that by checking whether links load. You cannot catch it by counting sources. It would sail through every integrity check that the entire category currently advertises, because the failure isn't in the retrieval, it's in the reasoning that happens after the retrieval.

The line I keep coming back to reached me through Nathan Lambert, who credits a pseudonymous account called Michael: "To an LLM, a novel discovery is indistinguishable from an error." These are information engines, not insight engines. They compress what has been published; they do not do the work of deciding what matters.

Here's the part that makes me feel slightly silly for treating any of this as a discovery. OpenAI wrote it down themselves, in the launch post, in February 2025, under a heading called Limitations:

> It can sometimes hallucinate facts in responses or **make incorrect inferences** [...] It may **struggle with distinguishing authoritative information from rumors**, and currently shows **weakness in confidence calibration, often failing to convey uncertainty accurately**.

Three things in one paragraph. Incorrect inference. Poor source discrimination. Confidence that isn't calibrated to the evidence. That's the entire 2026 failure profile, published by the vendor on day one, sitting underneath the benchmark charts that everybody quoted instead.

Which leaves the category somewhere awkward. It got much better at the thing everyone was worried about, and the weakness that remains is harder to see and more dangerous, because a fabricated citation announces itself the moment you click it and a bad inference just sits there looking reasonable.

## There is also no best tool, which is funnier than it sounds

The other thing that fell out of the reading was that the "which one is best" question has no stable answer, and the benchmark data is almost comic about it.

AIMultiple ran a proper evaluation in April 2026: six tools, five tasks, thirty-three binary checkpoints all verified against primary sources like SEC filings and official docs. The results:

| | Accuracy | Cost |
|---|---|---|
| Claude Code (plain CLI agent, web search only) | **97.0%** | $1.54 |
| Parallel Ultra (deep research API) | **97.0%** | $2.10 |
| Codex (plain CLI agent) | 93.9% | $1.30 |
| Perplexity Sonar Deep Research | 87.9% | |
| o4-mini Deep Research | 81.8% | |
| o3 Deep Research | 75.8% | $10.92 |

A coding CLI with ordinary web search and no special research infrastructure tied the best purpose-built deep-research system, at a seventh of the cost of the worst one. The most expensive model tested came last.

It gets better. On a different task in the same study, one that asked for a comparison table, Perplexity scored **zero**, because it returned prose. Not wrong prose. Just prose, when a table was asked for. Meanwhile Perplexity topped a different benchmark in the same write-up.

Volume turned out not to predict accuracy at all. One tool wrote 4,509 words about a Unity struct and named one of its five public methods; another named all five in 248 words. Three of the six fetched documentation for Unity 6.0 when the prompt had specified 6.3, and none managed to read four upgrade guides in sequence, which is the failure most likely to bite you in real work.

Underneath all of that sits a problem I didn't expect to find. A survey of eighty-plus deep research systems, published from Zhejiang University in June 2025, went looking for the benchmarks that would settle these arguments. There is **no literature-review benchmark**. There is **no methodology-assessment benchmark**. And there is no evidence that any deep research system from OpenAI, Google or Perplexity has ever been formally evaluated on TREC, the standard for information retrieval. The authors ended up proposing that someone use *Nature Reviews* articles as gold standards, because nothing suitable exists.

So the scores everyone quotes, mine included, are general-reasoning benchmarks standing in for research quality. They measure something adjacent to the thing we care about, because the thing we care about has never been given a ruler.

The reviews contradict each other, too, and that's fine once you look at the dates. SectionAI called Gemini Deep Research "unusable" for competitive analysis in March 2025. LivePlan found it excellent in May 2026, with better presentation and more sources than ChatGPT. Both are honest. The tool changed. Any comparison table you read without a date on it is decoration.

## So what should the product actually be

If no backend wins, and the remaining failure mode is inferential rather than factual, then the useful thing to build is not another research model. It's the layer around them.

That layer needs to do five jobs, and none of them are glamorous:

**Pick the right backend.** Not on vibes, on capability. Only Gemini lets you read and edit the research plan before it spends anything, which is the single highest-leverage control anyone has over output quality. Only xAI can search X. Only Perplexity can restrict to a date range or an allow-list of twenty domains, or enumerate seventy companies into a JSONL file with a source per row. If your question needs one of those, budget doesn't substitute.

**Stop it spending your money by accident.** These runs cost between one and eleven dollars each and take up to an hour. An assistant in a retry loop is a genuinely expensive bug.

**Keep the output out of your context window.** A sixty-thousand-token report dumped into a chat is not a research tool, it's a denial-of-service attack on your own session.

**Check the claims, not just the links.** This is the part that follows from everything above. Checking a URL resolves is table stakes and defends against 2025. Sampling claims, fetching what they cite, and asking whether the source actually supports the sentence attached to it is a different and harder job, and it's the one aimed at the failure that's still live.

**Say which sentences are the model's own.** The best idea I found in eighty pages of survey is also the cheapest: mark every claim as *sourced*, *synthesised* or *unverified*. Sourced means a citation backs this sentence. Synthesised means the inputs are cited but the connection between them is the system's. Unverified means neither, and shouldn't be presented as a finding at all.

That middle mark is the one that matters. Every input to Gemini's inflated market estimate was sourced; the multiplication was not. A reader told "this conclusion is synthesised from claims 4, 7 and 11" knows exactly where to point their scepticism. A reader given a confident paragraph does not. It costs nothing extra to produce, because it's a formatting discipline rather than a capability.

I want to be careful here, because this is where a post like this normally overclaims. None of it is solved. Claim-checking catches some things and misses others, and it will never catch a subtle inferential error the way a domain expert reading carefully would. What these moves do is shift the question from "does this link work" to "does this source say what the report claims, and which sentences did nobody source at all." That's a meaningfully better place to be standing, and it is not the same as being right.

## Dossier

That layer is what I built, and it's [open source and MIT-licensed](https://github.com/fledgeling-co/dossier-research-mcp).

Dossier is an MCP server. You connect it to Claude Code, Claude Desktop, Cursor, Codex, or anything else that speaks the protocol, and your assistant gains the ability to commission proper research: not a web search, an investigation running forty minutes across a hundred sources, coming back with something you can check.

```bash
claude mcp add dossier -e GEMINI_API_KEY=your-key -- npx -y dossier-research-mcp
```

Then you ask, in plain English. *Research which open-source vector databases support binary quantization, and what memory their docs claim at 10 million vectors.* Twenty minutes later there's a nineteen-section report with thirty cited sources, a comparison table, a confidence rating per claim, and an explicit list of what it could not find out.

The design follows from the three properties of the job. Runs are durable, so every step is written to disk before it's reported and closing your laptop doesn't kill a forty-minute investigation. Spending is gated, with a daily ceiling of $100 by default and each run reserving its **worst case** before the call is made, so the limit refuses early instead of discovering the overage afterwards. Reports arrive as a contents page first, and you pull the sections you want.

### What ships today

Being precise about this, since the article is about not overstating things.

**Four backends, and the free tiers I actually care about.** Only Gemini lets you edit the research plan before it spends. Perplexity's date and domain filters are enforced rather than asked for in a prompt. Nothing but xAI reaches X, at any price. OpenAI takes the largest domain filter of the four. Routing picks on capability first and price second, because no amount of cheapness makes an incapable backend correct.

The part that matters more, though, is **not having to pay per run at all.**

A **coding CLI you already pay for** can do the research. Claude Code, Codex, Cursor, Grok Build: Dossier shells out to whichever you have and takes the report. Given the benchmark above, where a plain CLI agent with web search tied the best hosted system, that isn't a consolation prize. It's the good option that happens to be free. It's never chosen automatically, mind: it costs nothing, so a price tie-break would pick it every single time, over a subscription quota Dossier can't meter.

A **share-link import** for anyone already paying for a chatbot. A Google AI Pro plan includes Deep Research in the Gemini web app, and a ChatGPT plan includes a monthly allowance. Run it there, hand Dossier the link or paste the text, and it does the brief-writing, normalising, citation-checking and storage around it.

That import path is deliberately the design rather than browser automation, for a reason worth saying out loud: `gemini.google.com/robots.txt` disallows `/app/`, and Google's terms prohibit automated access that violates machine-readable instructions on their pages, naming robots.txt specifically. The `/share/` path is not disallowed, which is lower risk rather than a safe harbour. A human clicking the button avoids the question, and cannot break when Google renames something.

And a **local loop** that costs nothing and uses whatever web search your session already has. Your client does the searching, because that's where the search is. What runs server-side is the part that can only be enforced there: findings accumulate into one numbered registry, the registry freezes before drafting, and a draft that cites anything you never gathered is **refused**. A prompt can ask a model not to reach for a plausible-looking reference mid-sentence. A server holding the registry can check.

Then the things the reviews argued for. `research_compare` runs one brief on two backends and diffs the claims, where disagreement about a number is the finding rather than something to average away. Support is counted in **independent domains**, never in how many backends agreed, because three agents citing one press release is one source with three wrappers. `research_verify_claims` fetches each cited page and asks whether it contains the claim, which is the check link-checking can't make. And a four-lens counter-review, each lens told to refute rather than summarise, that reports four empty lenses as a *failed review* rather than a clean bill of health.

Whatever you pay, you pay providers directly with your own keys. Dossier takes nothing and adds no markup. It's a router, not a middleman.

### What building it taught me about believing documentation

Every one of those backends was written against vendor docs and passed a full hermetic test suite. Then I ran one real request through each, and four things fell over.

Perplexity returns `COMPLETED` in upper case, against its own documentation's lower case. A case-sensitive check meant a finished run was never seen as finished: it polled until the watchdog gave up, and the report somebody had already paid for was never stored. Perplexity, OpenAI and xAI all return their citations out of band, in a sibling array rather than in the report, so a fully cited report was stored as an uncited one. And xAI accepts a `deferred` flag and ignores it, so its runs are synchronous when the capability record claimed they were durable.

None of that was findable without spending money on a real call. It's the same lesson as the article, one layer down. The docs are a description of the API, and a description is not the API.

An adversarial review then found the one that mattered most. The retry module opens by stating the rule that a call which spends money is never retried, names the mechanism that enforces it, and that mechanism had never been written. Every backend retried its paid POST four times. A create that timed out after the provider accepted it has already bought the report; retrying buys a second. The rule had been sitting in a comment for months, correct and unimplemented.

### What it doesn't do

Since the whole argument above is about honest limits, mine:

- "Verified citation" means the link resolves. It doesn't mean the source supports the claim. Claim checking is a separate, explicitly-costed step, and it's a sampling process rather than a proof.
- Mid-run progress isn't available on Gemini. Its API buffers it, and a 7.1-minute run reported nothing until it finished.
- Private-corpus grounding is Gemini only. OpenAI vector stores and xAI collections are real features and aren't wired up, so both declare no corpus support rather than routing your documents somewhere that ignores them.
- xAI runs inside the request rather than in the background, so it suits fast, broad questions rather than hour-long ones.
- Vertex AI works but loses features. An ordinary API key is the fuller backend, which surprises most people.
- Provider spend caps are soft for long-running agents, by their own documentation. Dossier's ceiling is the tighter of the two. Use both.

## Why this exists

I'm a founder and engineer, and I mostly build things from scratch. At **[Fledgeling](https://github.com/fledgeling-co)** I make fast, AI-native tools for people building from nothing: editors and engines where your work stays in plain text you own, nothing is a black box, and the AI can draft all it likes while you stay the editor of record. I'm also co-founder of Diolog with Amy Benson, building investor-relations software for listed companies and the retail investors who follow them.

Different surfaces, same conviction: **you should be able to check the thing you're trusting.**

Dossier was built for **margin**, which is the other half of this. Margin is a markdown editor and research app for web, macOS and iOS, built around living team pages: the strategy docs, playbooks and briefs that normally rot in a wiki the moment they're written. In margin those pages are alive. You comment on them by typing or by talking, listen to them read aloud, and hand the feedback to an embedded agent called Eve, who rewrites the section from your comment and commits the change to git while you watch the new text stream in.

The idea underneath it is that the gap between "someone noticed this page is wrong" and "the page is fixed" should be one conversation, not a ticket.

Research is where that gets interesting. Eve can scope a question, ask a couple of clarifying questions with the cost attached, and run a multi-minute investigation in the background; every report lands in a workspace library with a title and summary, viewable as markdown with its citations, reusable by the whole team. That's Dossier underneath, which is why it's shaped the way it is. It needed to survive someone closing a laptop, cost a predictable amount, and produce something a team could actually check rather than a wall of confident text.

Pulling it out as a standalone open-source MCP server was mostly a packaging exercise, because the thing was already provider-neutral infrastructure that happened to have exactly one provider plugged into it.

---

The gap between where these tools are and where the reviews say they are is about a year wide, in both directions. They fabricate far less than the 2025 write-ups suggest. They reason worse than the 2026 write-ups let on, and the reasoning failures are the ones that survive a careful read.

Which puts the useful work somewhere unglamorous: not in getting a better model to answer the question, but in being able to check what it told you.

---

<div align="center">

**[Dossier on GitHub](https://github.com/fledgeling-co/dossier-research-mcp)** · **[npm](https://www.npmjs.com/package/dossier-research-mcp)** · MIT

<sub>Luke Rhodes · <a href="https://www.linkedin.com/in/lukerhodes">in/lukerhodes</a> · <a href="https://github.com/lprhodes">github/lprhodes</a> · <a href="https://x.com/lp_rhodes">x/lp_rhodes</a></sub>

</div>
