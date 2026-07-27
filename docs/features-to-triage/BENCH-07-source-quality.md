# BENCH-07: source quality, independence and syndication

## What already exists

`classifySource` for the official, academic, journalism and community mix. `registrableDomain` for independent-domain counting. `assessSupport` for counting independent domains. Reuse all three; do not reimplement.

**Correction from BENCH-01, verified:** an earlier draft of this brief named `countsAsCorroboration` as the domain counter. It is not; it only filters a user's own documents out of independent corroboration. `assessSupport` is the one that counts domains.

## What is new: syndication detection

Four domains carrying the same wire story are one source wearing four hats, and independent-domain counting cannot see it. Detect by shingled hashing of fetched page text, and report the collapsed count alongside the raw one.

Both numbers are reported, never just the collapsed one. The shingle threshold is a judgement and a reader who disagrees with it needs the raw figure to reason from.

## Threshold warning

An earlier attempt at near-duplicate merging in `src/research/corroborate.ts` was rejected because published thresholds around 0.7 are tuned for article bodies and would silently collapse genuine corroboration between short claims. That objection does not apply here, because this operates on full fetched page text, which is what those thresholds were tuned for. Say so in the code, or someone will apply the earlier objection to the wrong thing.

## Acceptance

- Four copies of one wire story collapse to one source; four genuinely independent articles on the same event do not.
- The threshold is a named constant with its provenance in a comment.
