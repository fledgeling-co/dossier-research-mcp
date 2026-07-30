import { describe, expect, it } from 'vitest';
import {
  claimsRestingOnFailedCitations,
  renderClaimRisks,
  sentencesWithUrls,
} from '../src/research/claim-risk.js';
import {
  DUPLICATION_THRESHOLD,
  ECHO_THRESHOLD,
  assessReport,
  promptEchoRatio,
  selfDuplicationRatio,
} from '../src/research/report-qa.js';
import type { CitationVerdict } from '../src/store/types.js';

const at = '2026-07-29T10:00:00.000Z';
const v = (url: string, verdict: CitationVerdict['verdict'], registered?: boolean): CitationVerdict =>
  registered === undefined ? { url, verdict, checkedAt: at } : { url, verdict, registered, checkedAt: at };

describe('joining failed citations to the claims that rest on them', () => {
  // The real case: a disputed 400 W power floor whose only source did not
  // resolve. Dossier reported the broken URL and the claim separately, and the
  // caller did the join by hand.
  const REPORT = [
    '# Undervolting',
    '',
    'The card enforces a hard floor of 400 W, about 70% of stock, in its VBIOS (https://computerbase.example/5090-review).',
    '',
    'Curve Optimizer offsets of -30 are widely recommended (https://good.example/co) and measured broadly (https://also-good.example/co2).',
    '',
    'Fan curves are set per header (https://partly.example/gone) and confirmed in the manual (https://good.example/manual).',
  ].join('\n');

  it('names the claim whose ONLY source failed, not just the URL', () => {
    const risks = claimsRestingOnFailedCitations(REPORT, [
      v('https://computerbase.example/5090-review', 'not_found'),
      v('https://good.example/co', 'live'),
      v('https://also-good.example/co2', 'live'),
      v('https://partly.example/gone', 'unreachable'),
      v('https://good.example/manual', 'live'),
    ]);
    const sole = risks.filter((r) => r.reasons[0] === 'sole-source-unresolved');
    expect(sole).toHaveLength(1);
    expect(sole[0]!.claim).toContain('400 W');
    expect(sole[0]!.check).toMatch(/Nothing in this report currently supports this/);
  });

  it('ranks a claim with no surviving source above one with a gap', () => {
    const risks = claimsRestingOnFailedCitations(REPORT, [
      v('https://computerbase.example/5090-review', 'not_found'),
      v('https://partly.example/gone', 'unreachable'),
      v('https://good.example/manual', 'live'),
      v('https://good.example/co', 'live'),
      v('https://also-good.example/co2', 'live'),
    ]);
    expect(risks[0]!.reasons[0]).toBe('sole-source-unresolved');
    expect(risks.some((r) => r.reasons[0] === 'partly-unresolved')).toBe(true);
  });

  it('leaves a fully-cited claim alone', () => {
    const risks = claimsRestingOnFailedCitations(REPORT, [
      v('https://good.example/co', 'live'),
      v('https://also-good.example/co2', 'live'),
    ]);
    expect(risks).toEqual([]);
  });

  it('does not flag a paywalled source whose DOI is registered', () => {
    // The best evidence in a report is often the least reachable. Treating a
    // registered-but-blocked source as unsupported would fill the worklist with
    // journal articles that are exactly what you want to be citing.
    const md = 'The effect size was 0.4 (https://wiley.example/10.1002/x).';
    const risks = claimsRestingOnFailedCitations(md, [
      v('https://wiley.example/10.1002/x', 'blocked', true),
    ]);
    expect(risks).toEqual([]);
  });

  it('ignores reference-style link definitions, which are not claims', () => {
    const md = '[1]: https://example.com/a\n\nA real sentence with enough length to count (https://example.com/a).';
    const s = sentencesWithUrls(md);
    expect(s.every((x) => !x.text.startsWith('[1]:'))).toBe(true);
  });

  it('says plainly that Dossier cannot check these itself', () => {
    const out = renderClaimRisks(
      claimsRestingOnFailedCitations(REPORT, [v('https://computerbase.example/5090-review', 'not_found')]),
    ).join('\n');
    expect(out).toMatch(/no web search and cannot check these itself/);
    expect(out).toMatch(/WHICH claims need it/);
  });
});

describe('whether a finished report is actually a report', () => {
  it('catches a report that restated the brief instead of researching it', () => {
    const prompt =
      'Investigate the exact BIOS navigation for enabling Precision Boost Overdrive on ASUS AM5 motherboards, ' +
      'including the Curve Optimizer split-field quirk and the Curve Shaper temperature grid, and report literal breadcrumbs.';
    // The observed pathology: the brief handed back with headings on it.
    const echoed = `# Report\n\n${prompt}\n\n## Method\n\n${prompt}`;
    expect(promptEchoRatio(echoed, prompt)).toBeGreaterThan(ECHO_THRESHOLD);
    expect(assessReport(echoed, prompt).echoesPrompt).toBe(true);
  });

  it('does not flag an honest report that mentions its own subject', () => {
    const prompt = 'Investigate the exact BIOS navigation for Precision Boost Overdrive on ASUS AM5 motherboards.';
    const real = [
      '# Findings',
      'Precision Boost Overdrive sits under Ai Tweaker on most ASUS AM5 boards, and under Advanced then AMD Overclocking on others.',
      'The second route shows a disclaimer prompt that must be accepted before the submenu appears.',
      'Curve Optimizer is entered as a sign and a magnitude in two separate fields rather than as a signed number.',
      'Setting the sign to Negative and the magnitude to 25 gives an offset of minus 25 counts.',
    ].join('\n\n');
    expect(assessReport(real, prompt).echoesPrompt).toBe(false);
  });

  it('catches a report delivered twice in one body', () => {
    const body = Array.from(
      { length: 40 },
      (_, i) => `Finding ${String(i)} concerns the measured package power and its effect on sustained clocks under load.`,
    ).join('\n\n');
    expect(selfDuplicationRatio(`${body}\n\n${body}`)).toBeGreaterThan(DUPLICATION_THRESHOLD);
  });

  it('does not call ordinary prose duplicated', () => {
    const body = Array.from(
      { length: 40 },
      (_, i) => `Observation ${String(i)}: subject ${String(i)} drew ${String(i * 3)} watts across the ${String(i)}th trial run.`,
    ).join('\n\n');
    expect(assessReport(body, 'unrelated brief text here').heavilyDuplicated).toBe(false);
  });

  it('scores a short prompt as no echo rather than dividing by almost nothing', () => {
    expect(promptEchoRatio('a report about things', 'hi')).toBe(0);
  });
});
