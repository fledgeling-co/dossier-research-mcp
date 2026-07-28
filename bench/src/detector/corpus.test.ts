import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findImpureImports, importGraph } from '../import-graph.js';
import {
  DetectorCorpusError,
  labelCounts,
  loadDetectorCorpus,
  sha256Hex,
  type CorpusFileEntry,
} from './corpus.js';
import { detectorPaths, readDetectorCorpus } from './files.js';

/**
 * The loader, and the digest check that is the whole reason it can be trusted.
 *
 * A frozen corpus is what makes a detector eval reproducible, which the prior
 * art is explicit a live-web one can never be. A snapshot nobody can vouch for
 * buys none of that, so a fixture edited after labelling has to fail the load
 * rather than quietly change a number.
 */

const PAGE = 'The specification says the limit is 4096 bytes per cookie.';

function supportEntry(overrides: Record<string, string> = {}): CorpusFileEntry {
  const fields: Record<string, string> = {
    id: 'a-case',
    topic: '"a topic"',
    claim: '"The limit is 4096 bytes per cookie."',
    url: '"https://example.com/spec"',
    label: 'supports',
    why: '"The page states the figure and the unit exactly as the claim gives them, with nothing added."',
    ...overrides,
  };
  const page: Record<string, string> = {
    provenance: 'captured',
    capturedAt: '"2026-07-27"',
    verdict: 'live',
    httpStatus: '200',
    truncated: 'false',
    completeHtml: 'true',
    textFile: 'page.txt',
    textSha256: `"${sha256Hex(PAGE)}"`,
    textChars: String(PAGE.length),
  };
  const text = [
    ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`),
    'page:',
    ...Object.entries(page).map(([k, v]) => `  ${k}: ${v}`),
    '',
  ].join('\n');
  return { file: 'support/a-case.yaml', text };
}

const pages = new Map([['page.txt', PAGE]]);

describe('loadDetectorCorpus', () => {
  it('SELF-01: loads a case and joins its page text on', () => {
    const corpus = loadDetectorCorpus({
      supportFiles: [supportEntry()],
      registryFiles: [],
      pages,
    });
    expect(corpus.support).toHaveLength(1);
    expect(corpus.support[0]?.pageText).toBe(PAGE);
    expect(corpus.support[0]?.file).toBe('support/a-case.yaml');
    expect(corpus.judged).toBeNull();
  });

  it('SELF-03: refuses a fixture whose text no longer matches the recorded digest', () => {
    const tampered = new Map([['page.txt', `${PAGE} And one more sentence.`]]);
    let thrown: unknown;
    try {
      loadDetectorCorpus({ supportFiles: [supportEntry()], registryFiles: [], pages: tampered });
    } catch (e: unknown) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DetectorCorpusError);
    const message = thrown instanceof Error ? thrown.message : '';
    expect(message).toMatch(/hashes to/);
    expect(message).toMatch(/Re-capture it/);
  });

  it('refuses a case whose fixture is missing entirely', () => {
    expect(() =>
      loadDetectorCorpus({ supportFiles: [supportEntry()], registryFiles: [], pages: new Map() }),
    ).toThrow(/no page fixture named page.txt/);
  });

  it('refuses a character count that disagrees with the fixture', () => {
    const entry = supportEntry();
    const broken = { ...entry, text: entry.text.replace(/textChars: \d+/, 'textChars: 4') };
    expect(() =>
      loadDetectorCorpus({ supportFiles: [broken], registryFiles: [], pages }),
    ).toThrow(/characters, not the recorded/);
  });

  it('SELF-02: refuses a case whose reasoning is too thin to adjudicate against', () => {
    const entry = supportEntry({ why: '"it just is"' });
    expect(() =>
      loadDetectorCorpus({ supportFiles: [entry], registryFiles: [], pages }),
    ).toThrow(DetectorCorpusError);
  });

  it('refuses a page file name carrying a path separator', () => {
    const entry = supportEntry();
    const escaped = {
      ...entry,
      text: entry.text.replace('textFile: page.txt', 'textFile: ../../etc/passwd.txt'),
    };
    expect(() =>
      loadDetectorCorpus({ supportFiles: [escaped], registryFiles: [], pages }),
    ).toThrow(DetectorCorpusError);
  });

  it('collects every bad file before throwing, not just the first', () => {
    const a = { file: 'a.yaml', text: 'id: [unclosed' };
    const b = { file: 'b.yaml', text: 'id: 1\n' };
    let failures = 0;
    try {
      loadDetectorCorpus({ supportFiles: [a, b], registryFiles: [], pages });
    } catch (e: unknown) {
      if (e instanceof DetectorCorpusError) failures = e.failures.length;
    }
    expect(failures).toBe(2);
  });

  it('refuses two cases sharing an id, and names the file that took it first', () => {
    const first = supportEntry();
    const second = { ...supportEntry(), file: 'support/duplicate.yaml' };
    expect(() =>
      loadDetectorCorpus({ supportFiles: [first, second], registryFiles: [], pages }),
    ).toThrow(/duplicate id/);
  });

  it('refuses a judged evidence file naming a case that is not in the corpus', () => {
    const judgedJson = JSON.stringify({
      version: 1,
      model: 'claude',
      judgedAt: '2026-07-27',
      note: '',
      verdicts: [{ caseId: 'a-case-that-left', verdict: 'supports' }],
      failures: [],
    });
    expect(() =>
      loadDetectorCorpus({ supportFiles: [supportEntry()], registryFiles: [], pages, judgedJson }),
    ).toThrow(/not in the corpus/);
  });

  it('accepts a judged evidence file that matches, and carries the model forward', () => {
    const judgedJson = JSON.stringify({
      version: 1,
      model: 'claude',
      judgedAt: '2026-07-27',
      note: 'a note',
      verdicts: [{ caseId: 'a-case', verdict: 'supports' }],
      failures: [],
    });
    const corpus = loadDetectorCorpus({
      supportFiles: [supportEntry()],
      registryFiles: [],
      pages,
      judgedJson,
    });
    expect(corpus.judged?.model).toBe('claude');
    expect(corpus.judged?.verdicts).toHaveLength(1);
  });

  it('YAML is parsed as 1.2 core, so an unquoted date stays the text the author typed', () => {
    const entry = supportEntry();
    const parsed = loadDetectorCorpus({ supportFiles: [entry], registryFiles: [], pages });
    expect(parsed.support[0]?.page.capturedAt).toBe('2026-07-27');
  });
});

describe('labelCounts', () => {
  it('counts each label', () => {
    const counts = labelCounts([{ label: 'a' }, { label: 'a' }, { label: 'b' }]);
    expect(counts.get('a')).toBe(2);
    expect(counts.get('b')).toBe(1);
    expect(counts.get('c')).toBeUndefined();
  });
});

describe('SELF-04: what the score can and cannot reach', () => {
  /**
   * Decided on the **transitive** import graph, not on each file's own text.
   *
   * The previous version of this guard read each module's own source with two
   * regexes and a forbidden-import list. It passed for as long as it existed
   * while the claim it guarded was false, and it could not have done otherwise:
   * `report.ts` reaches `undici` three hops away and `node:child_process` six,
   * and neither word appears anywhere in `report.ts`. A check and the property it asserts
   * were of different kinds, and adding another name to the forbidden list
   * would not have closed that. The walk is `bench/src/import-graph.ts`, shared
   * with `bench/src/score/citations.test.ts` so there is one spelling of the
   * rule rather than three.
   *
   * The claim is now split, because the truth is split.
   */

  /** Genuinely pure: nothing reachable from these opens a file or a socket. */
  const PURE = ['./corpus.ts', './schema.ts', './verdicts.ts', './confusion.ts'];

  const at = (file: string): string => fileURLToPath(new URL(file, import.meta.url));

  it('the walk follows edges, or every check below is vacuous', () => {
    // `corpus.ts` imports siblings which import a package parser, so a walker
    // that reached only the entry file would pass every assertion here while
    // proving nothing. This is the guard's own guard.
    const graph = importGraph(at('./corpus.ts'));
    expect(graph.length).toBeGreaterThan(2);
    expect(graph).toContain(at('./schema.ts'));
  });

  it('the walk still flags a module that really is impure', () => {
    // Driven at the disk adapter, which reads files on purpose. A purity check
    // that is green because it can no longer see anything is the failure this
    // whole section is about.
    expect(findImpureImports(at('./files.ts')).map((r) => r.module)).toContain('node:fs');
  });

  it('reads no file and reaches no network, in any module the score passes through', () => {
    for (const file of PURE) {
      const reaches = findImpureImports(at(file));
      // The message carries the path, so a future failure names the edge to
      // change rather than only the module that was reached.
      expect(reaches.map((r) => `${r.module} via ${r.path.join(' -> ')}`), file).toEqual([]);
    }
  });

  it('and none of them imports the disk adapter, the capture pass or the judge', () => {
    for (const file of PURE) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      for (const forbidden of ['./files.js', './capture.js', './judge.js', './cli.js']) {
        expect(source, `${file} imports ${forbidden}`).not.toContain(`from '${forbidden}'`);
      }
    }
  });

  /**
   * `report.ts` is **not** pure, and this is the honest statement of what it is.
   *
   * It used to be in the list above and its own header used to say it "must
   * never import `node:fs` and must never reach a network". Both were false.
   * What is true is narrower and checkable: everything impure it can reach, it
   * reaches through `./arms.js`, and the arms are handed an offline fetcher, a
   * scripted transport, an in-memory cache and a fixed clock, so nothing is
   * called. That is **capability, not behaviour**, since the detector has never
   * made a network call, and the difference is the one BENCH-11 got right with a
   * resolve-hook trace and this guard got wrong with a regex.
   *
   * Asserting it positively rather than deleting the module from the list is
   * what keeps this a guard. If somebody later makes `report.ts` impure by some
   * *other* edge, this fails.
   */
  it('report.ts is impure, and the arms edge is the only way it is impure', () => {
    const reaches = findImpureImports(at('./report.ts'));
    expect(reaches.length).toBeGreaterThan(0);

    // The exact set, not a subset. An `arrayContaining` here would have passed
    // while the module's own header enumerated four of the six, which is the
    // shape of defect this whole item is about: a claim narrower than the truth
    // reads as reassuring and is still wrong. A new reach fails this and the
    // header has to be corrected with it.
    expect([...new Set(reaches.map((r) => r.module))].sort()).toEqual([
      'node:child_process',
      'node:dns/promises',
      'node:fs',
      'node:fs/promises',
      'node:net',
      'undici',
    ]);

    // Every one of them, without exception, arrives through the arms.
    for (const reach of reaches) {
      expect(reach.path, `${reach.module} reached without passing through arms.ts`).toContain(
        at('./arms.ts'),
      );
    }

    // And the arms really are the edge: everything else `report.ts` imports is
    // clean, which is what makes the sentence above a measurement rather than
    // an assertion.
    for (const sibling of ['./confusion.ts', './corpus.ts', './schema.ts', './verdicts.ts']) {
      expect(findImpureImports(at(sibling)), sibling).toEqual([]);
    }
  });

  it('would catch a filesystem import added later, in any of its forms', () => {
    // The one thing a graph walk cannot do is prove it would notice a form it
    // does not parse. These are the spellings the walker matches, and the
    // dynamic-import case is here because lifting the walk lost it once: the
    // regex this guard replaced caught `void import(...)` and the first version
    // of the walk did not. A form the codebase can write and this list omits is
    // a hole with a green test over it.
    const smuggled = [
      "import { readFileSync } from 'node:fs';",
      'import { readFileSync } from "node:fs";',
      "import { readFile } from 'node:fs/promises';",
      "void import('node:fs/promises');",
      "const fs = require('fs');",
      "import { createRequire } from 'node:module';",
      'await fetch(someUrl);',
    ];
    // The side-effect form is checked in `import-graph.test.ts` instead, since
    // it is a property of the walk rather than of one file's own text.
    const dir = mkdtempSync(join(tmpdir(), 'purity-'));
    for (const [i, line] of smuggled.entries()) {
      const file = join(dir, `smuggled-${String(i)}.ts`);
      writeFileSync(file, line, 'utf8');
      expect(findImpureImports(file).length, line).toBeGreaterThan(0);
    }
  });
});

describe('readDetectorCorpus', () => {
  it('SELF-01: reads the corpus that actually ships, with no network', () => {
    const corpus = readDetectorCorpus();
    expect(corpus.support.length).toBeGreaterThan(0);
    expect(corpus.registry.length).toBeGreaterThan(0);
  });

  it('returns an empty corpus for a directory that does not exist, rather than throwing', () => {
    const root = join(mkdtempSync(join(tmpdir(), 'detector-')), 'nothing-here');
    const corpus = readDetectorCorpus(root);
    expect(corpus.support).toEqual([]);
    expect(corpus.registry).toEqual([]);
  });

  it('reports a symbolic link rather than following it out of the corpus', () => {
    const root = mkdtempSync(join(tmpdir(), 'detector-'));
    const paths = detectorPaths(root);
    mkdirSync(paths.supportDir, { recursive: true });
    mkdirSync(paths.pagesDir, { recursive: true });
    const outside = join(root, 'outside.yaml');
    writeFileSync(outside, 'id: escaped\n', 'utf8');
    symlinkSync(outside, join(paths.supportDir, 'link.yaml'));

    const corpus = readDetectorCorpus(root);
    expect(corpus.support).toEqual([]);
    expect(corpus.ignoredFiles.some((f) => f.includes('symbolic link'))).toBe(true);
  });

  it('names a file it did not read as a case rather than dropping it silently', () => {
    const root = mkdtempSync(join(tmpdir(), 'detector-'));
    const paths = detectorPaths(root);
    mkdirSync(paths.supportDir, { recursive: true });
    writeFileSync(join(paths.supportDir, 'notes.md'), '# notes\n', 'utf8');
    const corpus = readDetectorCorpus(root);
    expect(corpus.ignoredFiles).toContain('notes.md');
  });
});
