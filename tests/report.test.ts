import { describe, expect, it } from 'vitest';
import {
  clampToTokens,
  estimateTokens,
  extractCitedUrls,
  findSection,
  grepReport,
  normaliseCitations,
  outlineReport,
  readSection,
  renderOutline,
} from '../src/research/report.js';
import { extractPlan } from '../src/research/plan.js';

const REPORT = `## Executive Summary

- (High Confidence) Vendor A leads on price. <cite url="https://example.com/pricing">pricing page</cite>
- (Low Confidence) Vendor B may exit the market.

## Detailed Findings

### Who leads on price?

Vendor A charges $12/seat [their pricing](https://example.com/a-pricing) versus $19 for B.

## Evidence Table

| Claim | Source | Date | Type | URL |
|---|---|---|---|---|
| A charges $12 | Vendor A | 2026-01 | Primary | https://example.com/a-pricing |

## Knowledge Gaps

- Enterprise discounting is not public.
`;

describe('outlineReport', () => {
  it('finds every heading with its level', () => {
    const sections = outlineReport(REPORT);
    expect(sections.map((s) => s.title)).toEqual([
      'Executive Summary',
      'Detailed Findings',
      'Who leads on price?',
      'Evidence Table',
      'Knowledge Gaps',
    ]);
    expect(sections[2]?.level).toBe(3);
  });

  it('sections partition the document without gaps or overlap', () => {
    const sections = outlineReport(REPORT);
    for (let i = 1; i < sections.length; i += 1) {
      expect(sections[i]?.start).toBe(sections[i - 1]?.end);
    }
    expect(sections.at(-1)?.end).toBe(REPORT.length);
  });

  it('treats a headingless document as one section', () => {
    const sections = outlineReport('just prose, no headings at all');
    expect(sections).toHaveLength(1);
    expect(sections[0]?.chars).toBe('just prose, no headings at all'.length);
  });

  it('renders an outline that names the follow-up call', () => {
    const rendered = renderOutline(REPORT);
    expect(rendered).toContain('Executive Summary');
    expect(rendered).toContain('research_read');
    // The whole point: the outline is far smaller than the report.
    expect(rendered.length).toBeLessThan(REPORT.length);
  });
});

describe('findSection / readSection', () => {
  it('finds by 1-based index', () => {
    const found = findSection(REPORT, '1');
    expect(found?.title).toBe('Executive Summary');
  });

  it('finds by exact and partial title, case-insensitively', () => {
    expect(findSection(REPORT, 'Evidence Table')?.title).toBe('Evidence Table');
    expect(findSection(REPORT, 'evidence')?.title).toBe('Evidence Table');
  });

  it('returns null for a miss and for an out-of-range index', () => {
    expect(findSection(REPORT, 'nonexistent heading')).toBeNull();
    expect(findSection(REPORT, '99')).toBeNull();
  });

  it('reads only the requested section', () => {
    const found = findSection(REPORT, 'Knowledge Gaps');
    expect(found).not.toBeNull();
    const body = readSection(REPORT, found!);
    expect(body).toContain('Enterprise discounting');
    expect(body).not.toContain('Executive Summary');
  });
});

describe('grepReport', () => {
  it('reports hits with their containing section', () => {
    const hits = grepReport(REPORT, '$12');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.section === 'Who leads on price?')).toBe(true);
  });

  it('treats the pattern as a literal by default', () => {
    // `$12` as a regex would never match; as a literal it does.
    expect(grepReport(REPORT, '$12').length).toBeGreaterThan(0);
  });

  it('supports opt-in regex and rejects a malformed one', () => {
    expect(grepReport(REPORT, 'Vendor [AB]', { regex: true }).length).toBeGreaterThan(0);
    expect(() => grepReport(REPORT, '([unclosed', { regex: true })).toThrow(/Invalid regular expression/);
  });

  it('caps the hit count', () => {
    const many = Array.from({ length: 100 }, () => 'match me').join('\n');
    expect(grepReport(many, 'match me', { maxHits: 5 })).toHaveLength(5);
  });
});

describe('citations', () => {
  it('rewrites both cite tag forms into markdown links', () => {
    const wrapped = normaliseCitations('<cite url="https://a.test/x">label</cite>');
    expect(wrapped).toBe('[label](https://a.test/x)');
    const selfClosing = normaliseCitations('<cite url="https://www.b.test/y"/>');
    expect(selfClosing).toBe('[b.test](https://www.b.test/y)');
  });

  it('extracts every distinct cited URL once', () => {
    const urls = extractCitedUrls(REPORT);
    expect(urls).toContain('https://example.com/pricing');
    expect(urls).toContain('https://example.com/a-pricing');
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('skips the UNVERIFIED sentinel', () => {
    expect(extractCitedUrls('<cite url="UNVERIFIED" note="nothing found">x</cite>')).toEqual([]);
  });

  it('strips trailing punctuation from bare URLs', () => {
    expect(extractCitedUrls('See https://a.test/page.')).toEqual(['https://a.test/page']);
  });
});

describe('clampToTokens', () => {
  it('leaves short text untouched', () => {
    const { text, truncated } = clampToTokens('short', 1000);
    expect(truncated).toBe(false);
    expect(text).toBe('short');
  });

  it('marks truncation explicitly rather than silently cutting', () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i} of prose here`).join('\n');
    const { text, truncated } = clampToTokens(long, 200);
    expect(truncated).toBe(true);
    expect(text).toContain('truncated at the requested token budget');
    expect(text).toContain('estimated tokens remain');
    expect(estimateTokens(text)).toBeLessThan(estimateTokens(long));
  });
});

describe('extractPlan (collaborative planning)', () => {
  // The exact shape the live API returns: a title, the whole submitted prompt
  // echoed back, then the actual plan.
  const PROMPT = `<role>\nYou are a senior research analyst evaluating software stacks.\n</role>\n\n<core_directive>\nAnswer this decisively: what changed?\n</core_directive>`;
  const RAW = `**Title:** Model Context Protocol Specification Analysis\n**Input:** ${PROMPT}\n**Research Plan:**\n(1) Locate the official specification.\n(2) Extract transport details.`;

  it('returns the plan, not the echoed prompt', () => {
    const { plan, title, strippedEcho } = extractPlan(RAW, PROMPT);
    expect(plan).toBe('(1) Locate the official specification.\n(2) Extract transport details.');
    expect(plan).not.toContain('senior research analyst');
    expect(title).toBe('Model Context Protocol Specification Analysis');
    expect(strippedEcho).toBe(true);
  });

  it('falls back to matching the submitted prompt when no marker is present', () => {
    const noMarker = `**Title:** X\n**Input:** ${PROMPT}\nJust do these three things.`;
    const { plan, strippedEcho } = extractPlan(noMarker, PROMPT);
    expect(plan).toContain('Just do these three things.');
    expect(plan).not.toContain('senior research analyst');
    expect(strippedEcho).toBe(true);
  });

  it('returns text unchanged when it is already a bare plan', () => {
    const bare = '(1) Do the thing.\n(2) Do the other thing.';
    const { plan, strippedEcho } = extractPlan(bare);
    expect(plan).toBe(bare);
    expect(strippedEcho).toBe(false);
  });

  it('handles an empty turn without throwing', () => {
    expect(extractPlan('').plan).toBe('');
  });
});
