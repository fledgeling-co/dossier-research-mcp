import { describe, expect, it } from 'vitest';
import { modelFamily, normaliseModelName } from '../src/local/cli.js';

/**
 * Whether two panel members judge from the same weights.
 *
 * The direction of caution here is the opposite of what it was. While a match
 * REMOVED a backend from the lane, refusing to match was the safe error: a
 * false positive silently deleted a member somebody was paying for. Nothing is
 * removed now — a match only records that two members share priors — so the
 * expensive error is a MISS, which tells an operator they have two independent
 * voices when they have one model wearing two hats.
 *
 * Both directions are still wrong, so both are tested.
 */
describe('modelFamily', () => {
  it('sees through a reseller prefix', () => {
    // The case that motivated this: Cursor is a multiplexer, and its own
    // --list-models offers `cursor-grok-4.5-high` beside Composer. Reached that
    // way it is the same weights as the Grok CLI.
    expect(modelFamily('cursor-grok-4.5-high')).toBe(modelFamily('Grok 4.5'));
    expect(modelFamily('claude-opus-5-thinking-high')).toBe(modelFamily('Opus 5'));
  });

  it('sees through an effort or speed suffix', () => {
    // Same weights turned up or down. For "do these two share priors", they do.
    expect(modelFamily('gpt-5.6-sol-high')).toBe(modelFamily('gpt-5.6-sol-xhigh'));
    expect(modelFamily('gpt-5.6-sol-high-fast')).toBe(modelFamily('gpt-5.6-sol'));
  });

  it('keeps different versions apart, which is the expensive false positive', () => {
    // Claiming these share priors would tell an operator their two-model check
    // is worthless when it is real.
    expect(modelFamily('gpt-5.6-sol-xhigh')).not.toBe(modelFamily('gpt-5.5-high'));
    expect(modelFamily('Grok 4.5')).not.toBe(modelFamily('Grok 4'));
    expect(modelFamily('claude-opus-5-thinking-high')).not.toBe(modelFamily('claude-opus-4-8-thinking-high'));
  });

  it('keeps different models apart', () => {
    expect(modelFamily('composer-2.5')).not.toBe(modelFamily('cursor-grok-4.5-high'));
    expect(modelFamily('Opus 5')).not.toBe(modelFamily('Grok 4.5'));
  });

  it('does not strip a vendor word that is the model’s own name', () => {
    // Only a LEADING vendor token is a reseller. `gemini-3.6-flash` is a model
    // called Gemini, and reducing it to `3.6 flash` would collide with anything
    // else versioned 3.6.
    expect(modelFamily('gemini-3.6-flash')).toContain('gemini');
    // And a bare vendor name with nothing after it keeps itself, rather than
    // reducing to the empty string and matching every other bare vendor name.
    expect(modelFamily('cursor')).toBe('cursor');
    expect(modelFamily('claude')).not.toBe(modelFamily('cursor'));
  });

  it('leaves the display form alone', () => {
    // `normalised` is what a reader is shown; `family` is only ever compared.
    // Collapsing one into the other would print `grok 4.5` for a member the
    // operator configured as `cursor-grok-4.5-high` and make the setting
    // unrecognisable in its own report.
    expect(normaliseModelName('cursor-grok-4.5-high')).toBe('cursor grok 4.5 high');
  });
});
