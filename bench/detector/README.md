# The detector corpus

A labelled corpus for measuring whether Dossier's own citation checking works.
Every case pairs a claim with a page and the answer that was already known
before any detector ran.

What each directory holds:

- `support/` one claim, one page, one of the five verdicts
  `research_verify_claims` asks a caller for.
- `registry/` one identifier and what the registries said about it, scripted so
  the answer cannot move between runs.
- `pages/` the page text as captured, pinned by SHA-256. The loader recomputes
  the digest and refuses the whole corpus on a mismatch.
- `evidence/` what a judged pass recorded, with the model and the date.

**Every case carries a `why`.** It is the field a dispute is settled against,
and it is a schema requirement rather than a convention: a label with no
argument behind it is an assertion of authority.

The full contract, every projection between vocabularies, and what each number
cannot mean are in [`docs/bench/detector-eval.md`](../../docs/bench/detector-eval.md).

```bash
npm run bench:detector                    # score offline; free
npm run bench:detector -- judge --confirm # run the judged pass; spends a quota
```
