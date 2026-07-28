import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_VERSION,
  emptyEvidence,
  pagesByUrl,
  parseEvidence,
  registryByIdentifier,
  type CitationEvidence,
} from './evidence.js';
import { evidenceMatchesReport, evidencePath, readEvidence, writeEvidence } from './store.js';

/**
 * The snapshot as a trust boundary.
 *
 * A snapshot read back from a disk is exactly the class of input `CLAUDE.md`
 * requires to be parsed rather than cast, and the failure mode is worse here
 * than in a listing: a listing that drops one bad row still renders, while a
 * score computed over evidence nobody can vouch for is a plausible-looking
 * number about a sample nobody chose. So a malformed snapshot is fatal.
 */

function snapshot(over: Partial<CitationEvidence> = {}): CitationEvidence {
  return {
    version: EVIDENCE_VERSION,
    collectedAt: '2026-07-27T00:00:00.000Z',
    pages: [
      {
        url: 'https://example.com/a',
        verdict: 'live',
        httpStatus: 200,
        text: 'Adoption reached 28.6%.',
        truncated: false,
        completeHtml: true,
        anchors: ['results'],
        published: {
          status: 'found',
          date: '2026-03-01',
          signal: 'json-ld',
          raw: '2026-03-01T09:00:00Z',
          detail: 'read from a schema.org `datePublished` in a JSON-LD block',
        },
        checkedAt: '2026-07-27T00:00:00.000Z',
      },
    ],
    registry: [
      {
        kind: 'doi',
        id: '10.1038/nature12373',
        status: 'present',
        via: 'crossref',
        detail: 'Crossref holds a record for this DOI',
        checkedAt: '2026-07-27T00:00:00.000Z',
      },
    ],
    notes: [],
    ...over,
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'bench-cite-store-'));
}

describe('the schema (INTEG-43)', () => {
  it('accepts a well-formed snapshot', () => {
    expect(parseEvidence(snapshot()).pages).toHaveLength(1);
  });

  it('refuses a snapshot with an unknown field rather than ignoring it', () => {
    expect(() => parseEvidence({ ...snapshot(), surprise: 1 })).toThrow(/malformed/);
  });

  it('refuses a snapshot from a future version', () => {
    expect(() => parseEvidence({ ...snapshot(), version: 99 })).toThrow(/malformed/);
  });

  it('refuses a verdict outside the product’s own vocabulary', () => {
    const bad = snapshot();
    const page = { ...bad.pages[0], verdict: 'probably-fine' };
    expect(() => parseEvidence({ ...bad, pages: [page] })).toThrow(/malformed/);
  });

  it('names where the problem was', () => {
    const bad = snapshot();
    const page = { ...bad.pages[0], truncated: 'yes' };
    expect(() => parseEvidence({ ...bad, pages: [page] })).toThrow(/pages\.0\.truncated/);
  });

  it('builds an empty snapshot for a collection that reached nothing', () => {
    const empty = emptyEvidence('2026-07-27T00:00:00.000Z');
    expect(() => parseEvidence(empty)).not.toThrow();
    expect(empty.pages).toEqual([]);
  });
});

describe('indexes', () => {
  it('keys pages by canonical url and registry answers by kind and id', () => {
    const evidence = snapshot();
    expect(pagesByUrl(evidence).get('https://example.com/a')?.verdict).toBe('live');
    expect(registryByIdentifier(evidence).get('doi 10.1038/nature12373')?.status).toBe('present');
  });
});

describe('the snapshot store (INTEG-43)', () => {
  it('round-trips through a disk', () => {
    const dir = tempDir();
    writeEvidence(dir, 'task-a/gemini/1', snapshot());
    expect(readEvidence(dir, 'task-a/gemini/1')?.pages).toHaveLength(1);
  });

  it('DATE-16 carries the publication date through the disk unchanged', () => {
    // The round trip above only counts pages. A field can survive a schema and
    // still be dropped by the writer or flattened by the reader, and this is the
    // field a whole scored dimension now rests on.
    const dir = tempDir();
    writeEvidence(dir, 'task-a/gemini/1', snapshot());
    expect(readEvidence(dir, 'task-a/gemini/1')?.pages[0]?.published).toEqual({
      status: 'found',
      date: '2026-03-01',
      signal: 'json-ld',
      raw: '2026-03-01T09:00:00Z',
      detail: 'read from a schema.org `datePublished` in a JSON-LD block',
    });
  });

  it('DATE-17 refuses a snapshot on disk written before the field existed', () => {
    const dir = tempDir();
    const stale = { ...snapshot(), version: 1 };
    writeFileSync(evidencePath(dir, 'old'), `${JSON.stringify(stale)}\n`, 'utf8');
    expect(() => readEvidence(dir, 'old')).toThrow(/malformed/);
  });

  it('hashes the cell key, so a task id with a slash does not become a directory tree', () => {
    const dir = tempDir();
    writeEvidence(dir, 'task-a/gemini/1', snapshot());
    expect(readdirSync(dir)).toHaveLength(1);
    expect(evidencePath(dir, 'task-a/gemini/1')).not.toContain('gemini');
  });

  it('leaves no temporary file behind', () => {
    const dir = tempDir();
    writeEvidence(dir, 'k', snapshot());
    expect(readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('returns undefined for a snapshot that was never written', () => {
    expect(readEvidence(tempDir(), 'never')).toBeUndefined();
  });

  it('throws rather than scoring against a corrupt snapshot', () => {
    const dir = tempDir();
    writeEvidence(dir, 'k', snapshot());
    writeFileSync(evidencePath(dir, 'k'), 'half a file', 'utf8');
    expect(() => readEvidence(dir, 'k')).toThrow(/not valid JSON/);
  });

  it('throws rather than scoring against a snapshot that fails the schema', () => {
    const dir = tempDir();
    writeFileSync(evidencePath(dir, 'k'), JSON.stringify({ version: 1 }), 'utf8');
    expect(() => readEvidence(dir, 'k')).toThrow(/malformed/);
  });
});

describe('matching a snapshot to its report', () => {
  it('recognises the report it was collected from', () => {
    const evidence = snapshot({ reportSha256: 'a'.repeat(64) });
    expect(evidenceMatchesReport(evidence, 'anything')).toBe(false);
  });

  it('accepts a snapshot that records no hash at all', () => {
    expect(evidenceMatchesReport(snapshot(), 'anything')).toBe(true);
  });
});

describe('DATE-16 and DATE-17 the publication date is required, and the version guards it', () => {
  it('refuses a page record with no publication date at all', () => {
    // Required rather than optional, because an optional field is a sentinel a
    // caller can forget and a forgotten one would report every source undated
    // while every test stayed green.
    const withoutIt = snapshot();
    const pages = withoutIt.pages.map(({ published: _drop, ...rest }) => rest);
    expect(() => parseEvidence({ ...withoutIt, pages })).toThrow(/malformed/);
  });

  it('accepts all three states and nothing else', () => {
    for (const published of [
      { status: 'absent', detail: 'the page was read in full and states no publication date' },
      { status: 'unchecked', detail: 'nothing was read from this page' },
    ] as const) {
      const s = snapshot();
      const first = s.pages[0];
      if (first === undefined) throw new Error('fixture lost its page');
      expect(parseEvidence({ ...s, pages: [{ ...first, published }] }).pages[0]?.published).toEqual(
        published,
      );
    }
    const s = snapshot();
    const first = s.pages[0];
    if (first === undefined) throw new Error('fixture lost its page');
    expect(() =>
      parseEvidence({ ...s, pages: [{ ...first, published: { status: 'guessed', detail: 'x' } }] }),
    ).toThrow(/malformed/);
  });

  it('refuses a found date that is not a calendar day, or carries an unknown signal', () => {
    const s = snapshot();
    const first = s.pages[0];
    if (first === undefined) throw new Error('fixture lost its page');
    for (const published of [
      { status: 'found', date: 'last Tuesday', signal: 'json-ld', raw: 'x', detail: 'y' },
      { status: 'found', date: '2026-03-01', signal: 'vibes', raw: 'x', detail: 'y' },
    ]) {
      expect(() => parseEvidence({ ...s, pages: [{ ...first, published }] })).toThrow(/malformed/);
    }
  });

  it('refuses a snapshot written before the field existed, rather than reading it as undated', () => {
    // The version bump is the mechanism. A version-1 snapshot genuinely cannot
    // answer the new question, and reading one as "no page here carries a date"
    // would print an undated share of 100% about a pass that never looked.
    const old = { ...snapshot(), version: 1 };
    expect(() => parseEvidence(old)).toThrow(/malformed/);
  });
});
