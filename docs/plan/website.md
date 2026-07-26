# The website: a one-page plan

**Status:** proposal, 26 July 2026. Nothing built, no images generated, no money spent. This is the page to argue with.

---

## The one idea

**The site is a proof desk.** Every claim on it carries the evidence that backs it, and the evidence is checkable by the visitor rather than asserted at them.

That is not a theme chosen for looks. Dossier exists because AI research stopped fabricating citations and started assembling correct facts into wrong conclusions, so the product is about *checking the thing you are trusting*. A marketing site for it that makes unsourced claims is committing the exact error it sells against. Margin's own `DESIGN.md` already lives here: its world is "galley proofs, the editor's pencil, the red pen, the highlighter strip", and its logo is the proofreader's caret. **The two products are the same idea at two altitudes, and one visual language covers both.**

## Aesthetic

Inherited wholesale from `margin/DESIGN.md` rather than invented, so the site, the app and the docs read as one company.

- **Direction:** precise · paper-born · quietly alive. Swiss structure, hairlines, one disciplined accent, proof-desk artifacts.
- **Colour:** paper `#FBFBF9`, ink `#17181A`, proof red `≈#C43A2B`, highlighter yellow. Light-first, full dark scheme ships.
- **Type:** Bricolage Grotesque for chrome, Space Mono for marks and metadata, Newsreader for the reading register. No serif in chrome, no grotesk in prose.
- **Signature:** the caret `‸`. Dossier gets the mono/technical register of the same system; Margin gets the reading register.
- Two directions Margin already rejected, and so do we: editorial cream-and-terracotta (the obvious reflex for a product called Margin) and neo-grotesque dark with an electric accent (Linear costume).

## Structure

```
/                     the argument, the proof, both doors
/dossier              open source: what it does, install, tools, security
/margin               the product: living pages, Eve, platforms, waitlist
/blog                 posts, each carrying the run that produced it
/evidence             every claim on this site, with its source        (the unusual one)
/failure-modes        what Dossier cannot catch                        (the unusual one)
/docs                 links into the repo docs rather than duplicating them
```

## Five mechanics, from the ideation pass

Chosen from thirty candidates across five isolated cognitive frames. Scored on novelty, viability and fit; traps excluded.

1. **The opening trick.** The hero is a short, confident, beautifully-written paragraph. You are invited to spot which parts are unsupported. Then the proof marks come on: two sentences highlight, and the margin shows four citations collapsing into one domain. Ten seconds, no jargon, and the non-technical visitor *feels* the problem rather than reading about it.
2. **One document, two altitudes.** Instead of a "for developers / for teams" fork, the page peels. It starts as a friendly Margin note; keep scrolling and the same content exposes its citation graph, then its independent-domain count, then the raw MCP tool calls underneath. Nobody is routed to a dumbed-down branch, and nothing is hidden between the layers.
3. **The install bar is furniture.** An OS-detected command bar (macOS · Linux · Windows · WSL) pinned on every page including the blog, showing `npx -y dossier-research-mcp@latest setup`. Next to it: what the command does, expandable, before you paste it. Asking someone to pipe a stranger's script into their shell and calling that the developer experience is the thing to avoid.
4. **Claims that survive their own product.** Every marketing claim is footnoted to `/evidence`, which shows the run, the date and the sources, **including the benchmarks Dossier loses**. A single-sourced claim is visibly marked as such.
5. **The blog is executable.** Each post opens with the exact invocation that produced it and can be re-run against today's sources, showing where the post has gone stale. Content marketing that is also a demo and a staleness check.

**Traps I am deliberately avoiding:** a live research widget in the hero (a real run is 4-60 minutes and $1-7, so it is neither fast enough nor affordable per visitor, the demo will be a recorded run with a scrubber); pinball/physics navigation (unusable, inaccessible); and a gamified "permadeath" demo (reads as unserious next to Margin's actual buyers).

## Images and video

Generated with `openai/gpt-image-2` via the Vercel AI Gateway. Both models confirmed reachable today.

**Concepts, all proof-desk rather than generic SaaS gradients:**
- Hero: a printed page under raking light, proofreader's marks in red, one passage highlighted, marginalia in the gutter
- The corroboration trap: four citation slips pinned to a board, three threads tracing back to one origin
- Independent domains: stacked printer's blocks, a single-source stack visibly wobbling
- Two altitudes: the same page photographed at reading distance and at loupe magnification
- Margin platform shots: real UI, not generated. **Screenshots, never invented interface.**
- Blog headers: one per post, abstract proof-desk texture

**Budget:** roughly 18-25 images at gpt-image-2 rates, plus 2-4 short Seedance 2.0 clips for the hero and the peel interaction, each seeded from an approved still. I will price both precisely from the gateway and come back before spending, rather than generating and presenting a bill.

## What I need from you

1. **Which AI Gateway key.** 1Password is locked, so I used the one in `margin/.env.local` to confirm both models are reachable. Tell me if the personal key is a different one.
2. **Where the site lives.** New repo, or a directory in an existing one? And is the intended deploy Vercel?
3. **Margin platform claims.** The docs mention macOS, Windows, iOS, Android, CLI and Expo, but I have not yet confirmed which of those actually ship. **I will not put a platform on the site without evidence.** A read of the repo is in flight; if a platform turns out to be planned rather than shipped, it gets labelled or dropped.
4. **Margin's call to action is the waitlist**, not a signup, the repo is explicit that it is members-only and invite-gated. Confirm that is still true, because it changes the whole right-hand door.
5. **Pricing.** The repo mentions monthly pricing and a downloads row. Do you want real numbers on the site, or waitlist-only for now?

## Build order

Plan approved → content written with the Luke voice skill and lint-gated → design direction formalised through design-craft, flows through ux-craft → static mock of the home page for approval → images generated once the mock is agreed → build → deploy.

Nothing after this line happens without your go-ahead.
