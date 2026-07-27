import { describe, expect, it } from 'vitest';
import {
  extractIdentifiers,
  hasTraversalSegment,
  isbnChecksumValid,
  normaliseIsbn,
  stripArxivVersion,
} from './identifiers.js';

/**
 * Identifier extraction, which is where a false accusation starts.
 *
 * Almost every test here is about *not* extracting something. An extractor that
 * turns a year, a page number or a version string into a reference produces an
 * identifier no registry has heard of, and the registry then truthfully reports
 * it absent, which is the benchmark manufacturing the exact finding it exists
 * to detect. The self-identifying-grammar rule is what those tests defend.
 */

describe('extraction (INTEG-17)', () => {
  it('finds a DOI in prose as well as in a link', () => {
    const found = extractIdentifiers(
      'The paper [Nature](https://doi.org/10.1038/nature12373) reports it, and so does doi:10.1145/3442188.',
    );
    expect(found.filter((f) => f.kind === 'doi').map((f) => f.id)).toEqual([
      '10.1038/nature12373',
      '10.1145/3442188',
    ]);
  });

  it('de-duplicates one identifier written three ways', () => {
    const found = extractIdentifiers(
      'See 10.1038/NATURE12373, and https://doi.org/10.1038/nature12373, and doi:10.1038/Nature12373.',
    );
    expect(found.filter((f) => f.kind === 'doi')).toHaveLength(1);
  });

  it('strips the full stop a sentence leaves on a DOI', () => {
    const [found] = extractIdentifiers('It is recorded at 10.1038/nature12373.');
    expect(found?.id).toBe('10.1038/nature12373');
  });

  it('keeps a balanced bracket in a DOI suffix and drops an unbalanced one', () => {
    expect(extractIdentifiers('10.1000/foo(bar)')[0]?.id).toBe('10.1000/foo(bar)');
    expect(extractIdentifiers('(see 10.1000/foobar)')[0]?.id).toBe('10.1000/foobar');
  });

  it('finds a CVE anywhere, because it spells its own name', () => {
    const found = extractIdentifiers('Log4Shell is cve-2021-44228 and it is severe.');
    expect(found[0]).toMatchObject({ kind: 'cve', id: 'CVE-2021-44228' });
  });
});

describe('the self-identifying-grammar rule (INTEG-15)', () => {
  it('does not read a bare number as a PMID', () => {
    const found = extractIdentifiers('Revenue reached 23636398 dollars in 2024, up from 1200.');
    expect(found.filter((f) => f.kind === 'pmid')).toEqual([]);
  });

  it('reads a PMID behind its context word or its host', () => {
    const found = extractIdentifiers(
      'See PMID: 23636398 and https://pubmed.ncbi.nlm.nih.gov/28644964/ for the data.',
    );
    expect(found.filter((f) => f.kind === 'pmid').map((f) => f.id)).toEqual(['23636398', '28644964']);
  });

  it('does not read a bare decimal as an arXiv id', () => {
    expect(extractIdentifiers('The ratio was 2509.04499 to one.').filter((f) => f.kind === 'arxiv')).toEqual([]);
  });

  it('does not read a bare run of digits as an ISBN', () => {
    expect(extractIdentifiers('Order number 9780262033848 shipped.').filter((f) => f.kind === 'isbn')).toEqual([]);
  });
});

describe('arXiv (INTEG-14)', () => {
  it('strips the version suffix, since the API resolves the base id', () => {
    expect(stripArxivVersion('2509.04499v3')).toBe('2509.04499');
    const found = extractIdentifiers('arXiv:2509.04499v3 and https://arxiv.org/abs/2509.04499');
    expect(found.filter((f) => f.kind === 'arxiv')).toHaveLength(1);
    expect(found[0]?.id).toBe('2509.04499');
  });

  it('reads the old-style archive form', () => {
    const found = extractIdentifiers('An older one: arXiv:math.GT/0309136.');
    expect(found[0]).toMatchObject({ kind: 'arxiv', id: 'math.gt/0309136' });
  });

  it('reads a pdf link', () => {
    expect(extractIdentifiers('https://arxiv.org/pdf/2508.06600')[0]?.id).toBe('2508.06600');
  });
});

describe('ISBN checksums (INTEG-13)', () => {
  it('accepts a valid thirteen-digit and ten-digit number', () => {
    expect(isbnChecksumValid('9780262033848')).toBe(true);
    expect(isbnChecksumValid('0306406152')).toBe(true);
  });

  it('accepts an X check digit', () => {
    expect(isbnChecksumValid(normaliseIsbn('0-8044-2957-x'))).toBe(true);
  });

  it('rejects a mistyped number', () => {
    expect(isbnChecksumValid('9780262033847')).toBe(false);
  });

  it('marks a checksum failure invalid rather than leaving it to a registry', () => {
    const [found] = extractIdentifiers('ISBN 978-0-262-03384-7 is cited.');
    expect(found?.kind).toBe('isbn');
    expect(found?.invalidReason).toMatch(/check digit/);
  });

  it('carries no invalid reason for a good number', () => {
    const [found] = extractIdentifiers('ISBN 978-0-262-03384-8 is cited.');
    expect(found?.invalidReason).toBeUndefined();
  });
});

describe('path traversal (INTEG-16)', () => {
  it('recognises a traversal segment', () => {
    expect(hasTraversalSegment('10.1000/../secret')).toBe(true);
    expect(hasTraversalSegment('10.1000/./secret')).toBe(true);
    expect(hasTraversalSegment('10.1000/normal.suffix')).toBe(false);
  });

  it('marks such a DOI invalid at extraction', () => {
    const [found] = extractIdentifiers('10.1000/../etc/passwd');
    expect(found?.invalidReason).toMatch(/traversal/);
  });
});

describe('ordering', () => {
  it('returns identifiers in the order they appear, whatever kind they are', () => {
    const found = extractIdentifiers(
      'First CVE-2021-44228, then 10.1038/nature12373, then PMID: 23636398.',
    );
    expect(found.map((f) => f.kind)).toEqual(['cve', 'doi', 'pmid']);
  });
});
