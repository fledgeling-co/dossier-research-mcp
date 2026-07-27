import { describe, expect, it } from 'vitest';
import { findConvergence } from '../src/research/corroborate.js';

describe('convergence is found by subject, not by wording', () => {
  // From a real panel run. Five backends reached the same four conclusions and
  // the merge reported "0 claims more than one backend made", because matching
  // needed near-identical wording. The zero was then rendered as "these reports
  // do not overlap", which is a confident negative from a test that had no
  // power to find a positive. Same defect as the nothingFound boolean.
  const sets = [
    { provider: 'cursor', claims: [{ provider: 'cursor', text: 'Fine-tune a sub-500M encoder or a 0.6B decoder rather than training from scratch or prompting a frontier model.', urls: ['https://a.example/1'] }] },
    { provider: 'grok', claims: [{ provider: 'grok', text: 'The right approach is fine-tuning a small 0.6B decoder model; training from scratch is wasteful and frontier prompting is too slow.', urls: ['https://b.example/2'] }] },
    { provider: 'gemini', claims: [{ provider: 'gemini', text: 'Recommend fine-tuning an encoder under 500M parameters, not from-scratch training.', urls: ['https://c.example/3'] }] },
    { provider: 'perplexity', claims: [{ provider: 'perplexity', text: 'Kubernetes ingress controllers should be configured with a readiness probe.', urls: ['https://d.example/4'] }] },
  ];

  it('groups the same finding across backends that worded it differently', () => {
    const found = findConvergence(sets);
    const top = found[0];
    expect(top, 'nothing converged, which is the bug this test exists for').toBeDefined();
    expect(top?.providers.length).toBeGreaterThanOrEqual(2);
    expect(top?.providers).toContain('cursor');
    expect(top?.providers).toContain('grok');
    // The distinctive terms are what carried it, not the common ones.
    expect(top?.sharedTokens).toContain('0.6b');
    expect(top?.sharedTokens).toContain('decoder');
  });

  it('does not group an unrelated claim in', () => {
    const found = findConvergence(sets);
    for (const c of found) {
      const texts = c.claims.map((x) => x.text).join(' ');
      if (texts.includes('Kubernetes')) {
        expect(c.providers, 'the ingress claim converged with something it shares nothing with').toHaveLength(1);
      }
    }
  });

  it('shows the shared terms, so a reader can reject the pairing', () => {
    // The score alone is unfalsifiable. The evidence for the match has to be
    // visible or this is just a different opaque judgement.
    const top = findConvergence(sets)[0];
    expect(top?.sharedTokens.length).toBeGreaterThan(0);
    expect(top?.overlap).toBeGreaterThan(0);
  });

  it('never treats one backend repeating itself as convergence', () => {
    const repeated = [
      { provider: 'solo', claims: [
        { provider: 'solo', text: 'Fine-tune a small encoder model for routing.', urls: ['https://a.example/1'] },
        { provider: 'solo', text: 'Fine-tune a small encoder model for the routing task.', urls: ['https://a.example/2'] },
      ] },
    ];
    expect(findConvergence(repeated)).toHaveLength(0);
  });
});
