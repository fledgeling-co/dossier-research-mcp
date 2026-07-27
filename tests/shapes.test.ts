import { describe, expect, it } from 'vitest';
import {
  buildWidePrompt,
  DEFAULT_WINDOW,
  parseWideTable,
  renderWideTable,
  validateWide,
  windowEnforcement,
  windowToFromDate,
  windowToRecency,
  type WideRow,
  type WideSpec,
} from '../src/research/shapes.js';
import {
  assessSupport,
  canonicaliseUrl,
  crossCheck,
  diffClaims,
  registrableDomain,
} from '../src/research/corroborate.js';

const spec: WideSpec = {
  topic: 'Vector databases with binary quantization',
  entities: ['Qdrant', 'Milvus'],
  fields: [
    { name: 'binary_quantization', detail: 'brief' },
    { name: 'memory_at_10m', detail: 'moderate' },
  ],
};

describe('the wide shape', () => {
  it('marks uncertainty per cell, not per report', () => {
    const rows: WideRow[] = [
      {
        entity: 'Qdrant',
        cells: {
          binary_quantization: { value: 'yes', uncertain: false },
          memory_at_10m: { value: '~1.2 GB', uncertain: true },
        },
        uncertain: [],
      },
    ];
    const md = renderWideTable(spec, rows);
    expect(md).toContain('| Qdrant | yes | ~1.2 GB `[uncertain]` |');
    // The confident cell is not tarred by the uncertain one beside it.
    expect(md).not.toContain('yes `[uncertain]`');
  });

  it('names what it could not establish rather than leaving holes', () => {
    const rows: WideRow[] = [
      { entity: 'Milvus', cells: { binary_quantization: { value: 'yes', uncertain: false } }, uncertain: ['memory_at_10m'] },
    ];
    const md = renderWideTable(spec, rows);
    expect(md).toContain('What could not be established');
    expect(md).toContain('**Milvus**: memory_at_10m');
  });

  it('escapes pipes so one value cannot break the table', () => {
    const rows: WideRow[] = [
      { entity: 'X', cells: { binary_quantization: { value: 'a | b', uncertain: false } }, uncertain: ['memory_at_10m'] },
    ];
    expect(renderWideTable(spec, rows)).toContain('a \\| b');
  });

  it('refuses to call a run complete when a field was silently dropped', () => {
    // The failure this gate exists for: a model quietly omits the awkward
    // column and the table looks finished.
    const rows: WideRow[] = [
      { entity: 'Qdrant', cells: { binary_quantization: { value: 'yes', uncertain: false } }, uncertain: [] },
      { entity: 'Milvus', cells: { binary_quantization: { value: 'yes', uncertain: false } }, uncertain: ['memory_at_10m'] },
    ];
    const problems = validateWide(spec, rows);
    expect(problems).toContain('Qdrant: field "memory_at_10m" is neither filled nor declared uncertain');
    // Declaring it uncertain IS an acceptable answer; omitting it is not.
    expect(problems.some((p) => p.startsWith('Milvus'))).toBe(false);
  });

  it('reports a missing row', () => {
    expect(validateWide(spec, [])).toContain('missing row: Qdrant');
  });
});

describe('time windows', () => {
  it('defaults to a year, because most research questions are not news', () => {
    expect(DEFAULT_WINDOW).toBe('1y');
  });

  it('maps to a recency bucket where one exists and admits when it does not', () => {
    expect(windowToRecency('7d')).toBe('week');
    expect(windowToRecency('5y')).toBeUndefined();
  });

  it('produces a from-date for range filters', () => {
    const from = windowToFromDate('30d', new Date('2026-07-25T00:00:00Z'));
    expect(from).toBe('2026-06-25');
  });

  it('distinguishes an enforced window from a merely requested one', () => {
    // The distinction users need: on Gemini a window is a sentence in a prompt.
    expect(windowEnforcement('range', '30d')).toBe('enforced');
    expect(windowEnforcement('recency-bucket', '7d')).toBe('enforced');
    expect(windowEnforcement('recency-bucket', '5y')).toBe('requested');
    expect(windowEnforcement('none', '30d')).toBe('requested');
  });
});

describe('corroboration counts independent domains, not agreements', () => {
  it('collapses tracking parameters, www and trailing slashes', () => {
    const a = canonicaliseUrl('https://www.Example.com/a/?utm_source=x&gclid=y#frag');
    const b = canonicaliseUrl('https://example.com/a');
    expect(a).toBe(b);
  });

  it('treats subdomains of one site as one source', () => {
    expect(registrableDomain('https://docs.example.com/x')).toBe('example.com');
    expect(registrableDomain('https://blog.example.com/y')).toBe('example.com');
    // And handles two-label public suffixes rather than overcounting them.
    expect(registrableDomain('https://news.bbc.co.uk/a')).toBe('bbc.co.uk');
  });

  it('refuses to call two backends citing one domain corroboration', () => {
    // The rule the whole module exists for.
    const v = assessSupport([
      { provider: 'gemini', text: 'Revenue grew 12%', urls: ['https://vendor.com/press'] },
      { provider: 'perplexity', text: 'Revenue grew 12%', urls: ['https://vendor.com/press?utm_source=x'] },
    ]);
    expect(v.independentDomains).toBe(1);
    expect(v.support).toBe('single-source');
    expect(v.note).toMatch(/same domain, so this is one source rather than 2/);
  });

  it('grades genuinely independent domains upward', () => {
    const v = assessSupport([
      { provider: 'gemini', text: 'Revenue grew 12%', urls: ['https://a.com/1', 'https://b.org/2'] },
      { provider: 'perplexity', text: 'Revenue grew 12%', urls: ['https://c.net/3'] },
    ]);
    expect(v.independentDomains).toBe(3);
    expect(v.support).toBe('corroborated');
  });

  it('never presents a claim with no resolvable source as a finding', () => {
    const v = assessSupport([{ provider: 'gemini', text: 'Something', urls: [] }]);
    expect(v.support).toBe('unsupported');
    expect(v.note).toMatch(/Never present this as a finding/);
  });

  it('flags near-identical wording as possible syndication', () => {
    // Twenty outlets carrying one wire story is twenty domains and one source.
    const long = 'The company announced on Tuesday that it would acquire the rival for four billion dollars in cash and stock';
    const v = assessSupport([
      { provider: 'gemini', text: long, urls: ['https://a.com/1'] },
      { provider: 'perplexity', text: long, urls: ['https://b.com/2'] },
    ]);
    expect(v.note).toMatch(/syndicated wire story/);
  });

  it('separates agreement, conflict and coverage gaps', () => {
    const d = diffClaims(
      {
        provider: 'gemini',
        claims: [
          { provider: 'gemini', text: 'Shared claim', urls: ['https://a.com/1'] },
          { provider: 'gemini', text: 'Only gemini found this', urls: ['https://a.com/2'] },
        ],
      },
      {
        provider: 'perplexity',
        claims: [
          { provider: 'perplexity', text: 'Shared claim', urls: ['https://b.com/1'] },
          { provider: 'perplexity', text: 'Only perplexity found this', urls: ['https://b.com/2'] },
        ],
      },
    );
    expect(d.agreed).toHaveLength(1);
    expect(d.agreed[0]?.support).toBe('weakly-supported');
    expect(d.onlyA).toHaveLength(1);
    expect(d.onlyB).toHaveLength(1);
  });
});

describe('reading a returned matrix back', () => {
  const report = [
    '# Comparison',
    '',
    'Some preamble the model felt like writing.',
    '',
    '| entity | binary_quantization | memory_at_10m |',
    '|---|---|---|',
    '| Qdrant | yes | ~1.2 GB `[uncertain]` |',
    '| Milvus | yes | n/a |',
    '',
    'Trailing prose.',
  ].join('\n');

  it('parses the table out of a report that is mostly prose', () => {
    const rows = parseWideTable(spec, report);
    expect(rows.map((r) => r.entity)).toEqual(['Qdrant', 'Milvus']);
    expect(rows[0]?.cells['memory_at_10m']?.uncertain).toBe(true);
    expect(rows[0]?.cells['binary_quantization']?.uncertain).toBe(false);
  });

  it('treats an n/a cell as a gap rather than an answer', () => {
    const rows = parseWideTable(spec, report);
    expect(rows[1]?.uncertain).toContain('memory_at_10m');
    expect(validateWide(spec, rows)).toEqual([]);
  });

  it('reports every row as missing when the model answered in prose', () => {
    // The failure wide research exists to catch. Returning "no problems" for a
    // report with no table would invert the point of the gate.
    const problems = validateWide(spec, parseWideTable(spec, 'No table here, just an essay.'));
    expect(problems).toContain('missing row: Qdrant');
    expect(problems).toContain('missing row: Milvus');
  });

  it('catches a silently dropped column', () => {
    const partial = ['| entity | binary_quantization |', '|---|---|', '| Qdrant | yes |'].join('\n');
    const problems = validateWide(spec, parseWideTable(spec, partial));
    expect(problems.some((p) => p.includes('memory_at_10m'))).toBe(true);
  });

  it('survives a round trip through the renderer', () => {
    const rows = parseWideTable(spec, report);
    expect(parseWideTable(spec, renderWideTable(spec, rows))).toEqual(rows);
  });
});

describe('the wide prompt', () => {
  it('ends on the re-anchor, with nothing after it', () => {
    // The repo-wide invariant: content after the final `</core_directive>` can
    // be ignored entirely by the model.
    const prompt = buildWidePrompt(spec, '1y');
    expect(prompt.trimEnd().endsWith('</core_directive>')).toBe(true);
  });

  it('states the three requirements that stop a table quietly becoming an essay', () => {
    const prompt = buildWidePrompt(spec, '30d');
    expect(prompt).toMatch(/ONE markdown table/);
    expect(prompt).toMatch(/\[uncertain\]`, never omitted/);
    expect(prompt).toMatch(/last 30d/);
  });
});

describe('comparing more than two backends', () => {
  it('groups a claim by how many backends made it, not how many URLs it has', () => {
    const mk = (provider: string, text: string, url: string) => ({ provider, text, urls: [url] });
    const { shared, unique } = crossCheck([
      { provider: 'a', claims: [mk('a', 'Everyone agrees', 'https://x.com/1'), mk('a', 'Only a', 'https://x.com/2')] },
      { provider: 'b', claims: [mk('b', 'Everyone agrees', 'https://y.org/1')] },
      { provider: 'c', claims: [mk('c', 'Everyone agrees', 'https://z.net/1')] },
    ]);
    expect(shared).toHaveLength(1);
    expect(shared[0]?.providers).toEqual(['a', 'b', 'c']);
    expect(shared[0]?.support).toBe('corroborated');
    expect(unique.find((u) => u.provider === 'a')?.claims).toHaveLength(1);
    expect(unique.find((u) => u.provider === 'b')?.claims).toHaveLength(0);
  });

  it('still refuses to call three backends citing one domain corroboration', () => {
    const { shared } = crossCheck([
      { provider: 'a', claims: [{ provider: 'a', text: 'Same claim', urls: ['https://vendor.com/press'] }] },
      { provider: 'b', claims: [{ provider: 'b', text: 'Same claim', urls: ['https://vendor.com/press?utm_source=b'] }] },
      { provider: 'c', claims: [{ provider: 'c', text: 'Same claim', urls: ['https://www.vendor.com/press/'] }] },
    ]);
    expect(shared[0]?.support).toBe('single-source');
    expect(shared[0]?.note).toMatch(/3 backends agree/);
  });
});

describe('a wide cell that asserts a fact without a source', () => {
  const cited = [
    '| entity | binary_quantization | memory_at_10m |',
    '|---|---|---|',
    '| Qdrant | yes https://qdrant.tech/docs | ~1.2 GB https://qdrant.tech/bench |',
  ].join('\n');
  const uncited = [
    '| entity | binary_quantization | memory_at_10m |',
    '|---|---|---|',
    '| Qdrant | yes | ~1.2 GB |',
  ].join('\n');

  it('keeps the source when the cell carries one', () => {
    const rows = parseWideTable(spec, cited);
    expect(rows[0]?.cells['binary_quantization']?.source).toBe('https://qdrant.tech/docs');
    expect(validateWide(spec, rows, { requireSources: true }).filter((p) => p.includes('no source'))).toEqual([]);
  });

  it('reports an uncited fact only when asked, so the gate stays about completeness', () => {
    // A matrix may legitimately cite in its own column rather than in every
    // cell, so refusing that would be the completion gate deciding a
    // formatting question.
    const rows = parseWideTable(spec, uncited);
    expect(validateWide(spec, rows).filter((p) => p.includes('no source'))).toEqual([]);
    const strict = validateWide(spec, rows, { requireSources: true });
    expect(strict.some((p) => p.includes('asserts a fact with no source'))).toBe(true);
  });
});

describe('a declared gap is recognised however it is written', () => {
  // The em dash in DECLARED_GAP is data being parsed, not prose being written.
  // A blanket no-em-dash sweep replaced it with a comma once, quietly turning
  // "the model said there is nothing here" into "the model wrote a comma", and
  // the whole suite stayed green. This is the test that would have caught it.
  const spec = { topic: 't', entities: ['E'], fields: [{ name: 'f' }] };

  it.each(['—', '–', '-', '--', 'n/a', 'N/A', 'none', 'unknown', 'not found', '_not found_'])(
    'treats %j as a declared gap rather than as a value',
    (cell) => {
      const rows = parseWideTable(spec, `| entity | f |\n|---|---|\n| E | ${cell} |`);
      expect(rows[0]?.uncertain, cell).toContain('f');
      expect(rows[0]?.cells['f'], cell).toBeUndefined();
    },
  );

  it('does not mistake a real value for a gap', () => {
    const rows = parseWideTable(spec, `| entity | f |\n|---|---|\n| E | 1.2 GB |`);
    expect(rows[0]?.cells['f']?.value).toBe('1.2 GB');
    expect(rows[0]?.uncertain).not.toContain('f');
  });
});
