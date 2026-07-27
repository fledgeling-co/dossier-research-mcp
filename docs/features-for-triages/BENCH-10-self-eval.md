# BENCH-10: does Dossier's own checking actually work

## Why this is a different kind of eval

Every other brief measures research quality. This one measures a detector, and it cannot use the same method.

`research_verify_citations` and `research_verify_claims` claim to catch a bad citation. Testing that needs a labelled corpus where the answer is already known: real pages paired with claims that are genuinely supported, partially supported, contradicted, or simply not addressed. The score is a confusion matrix, not a quality score.

Without that ground truth you can only measure whether the verifier is confident, not whether it is right.

## What to build

- A labelled corpus under `bench/detector/`: `{ claim, url, label }` where label is the four verdicts plus `unreadable`.
- Cases constructed deliberately, including the hard ones: a page about the right topic that does not contain the claim (the `not_addressed` case that link-checking cannot see), a page that contradicts it, a page behind a cookie wall.
- Precision and recall per verdict, and the confusion matrix in full. Aggregate accuracy hides the failure that matters, which is `not_addressed` being scored as `supports`.

## Both modes, compared

`research_verify_claims` runs either with a model judging or with the caller judging. Both should be scored against the same corpus, because the honest question is not whether the model mode is good but whether it is better than free.

## Why this is the most valuable artefact here

It is the only part of the benchmark that tests Dossier's own claim rather than a provider's. Everything else could be run by anyone against any tool; this measures whether the thing this product is for actually works.

## Acceptance

- The corpus is balanced enough that a detector answering `supports` to everything scores badly, and that is asserted by a test.
- Every case records why it was labelled as it was, so a disputed label is adjudicated against reasoning rather than against authority.
