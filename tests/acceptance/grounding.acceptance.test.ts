import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpHarness, makeRun, REPORT_FIXTURES } from './harness.js';

/**
 * GROUND-01..09, 14.
 *
 * `research_ground`'s local path is free, keyless and sends nothing anywhere, so
 * the whole of it runs here against the real protocol. The upload path is
 * covered for its guard clauses and its description, which is all that can be
 * checked without a key and all that matters before bytes leave the machine.
 *
 * Two harnesses, because the interesting behaviour is the difference between a
 * server whose operator granted a directory and one whose operator did not, and
 * `DOSSIER_LOCAL_CORPUS_DIRS` is read once at start-up.
 */

let granted: McpHarness;
let ungranted: McpHarness;
let corpusRoot: string;
let secondRoot: string;

const RUN = 'dr_ground00001';
const RUNNING = 'dr_ground00002';
const GROUNDED = 'dr_ground00003';

beforeAll(async () => {
  corpusRoot = await mkdtemp(join(tmpdir(), 'dossier-corpus-'));
  secondRoot = await mkdtemp(join(tmpdir(), 'dossier-corpus2-'));

  granted = await McpHarness.create({
    DOSSIER_LOCAL_CORPUS_DIRS: `${corpusRoot}:${secondRoot}`,
  });
  await granted.store.saveRun(makeRun({ id: RUN, state: 'completed', title: 'Vector DB latency' }));
  await granted.store.saveReport(RUN, REPORT_FIXTURES.realistic);
  await granted.store.saveRun(makeRun({ id: RUNNING, state: 'running' }));
  await granted.store.saveRun(
    makeRun({ id: GROUNDED, state: 'completed', groundedIn: [RUN], title: 'The follow-up' }),
  );
  await granted.store.saveReport(GROUNDED, REPORT_FIXTURES.realistic);

  ungranted = await McpHarness.create();
  await ungranted.store.saveRun(makeRun({ id: RUN, state: 'completed' }));
  await ungranted.store.saveReport(RUN, REPORT_FIXTURES.realistic);
}, 60_000);

afterAll(async () => {
  await granted.dispose();
  await ungranted.dispose();
  await rm(corpusRoot, { recursive: true, force: true });
  await rm(secondRoot, { recursive: true, force: true });
});

describe('GROUND-01: a finished report becomes an input with no export step', () => {
  it('registers and grounds a completed run in one call', async () => {
    const names = (await granted.listTools()).map((t) => t.name);
    expect(names).toContain('research_ground');

    const result = await granted.callTool('research_ground', { runIds: [RUN] });
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/nothing was sent anywhere/);
    // The report is on disk, whole, without anyone having called research_export.
    const written = await readFile(
      join(corpusRoot, 'dossier-grounding', `dossier-run-${RUN}.md`),
      'utf8',
    );
    expect(written).toMatch(/Qdrant reports 12ms p99/);
  });

  it('refuses a run that has no report yet, rather than writing an empty one', async () => {
    const result = await granted.callTool('research_ground', { runIds: [RUNNING] });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/No report for/);
  });

  it('refuses a run id that is not in the store', async () => {
    const result = await granted.callTool('research_ground', { runIds: ['dr_nosuchrun'] });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/No run with id/);
  });
});

describe('GROUND-02: local is the default and upload has to be asked for', () => {
  it('declares the default in the tool schema, where it cannot be forgotten', async () => {
    const tool = (await granted.listTools()).find((t) => t.name === 'research_ground');
    const schema = JSON.stringify(tool);
    expect(schema).toMatch(/"default":"local"/);
  });

  it('grounds locally when no destination is named at all', async () => {
    const result = await granted.callTool('research_ground', { runIds: [RUN] });
    expect(result.text).toMatch(/Grounded 1 report\(s\) locally/);
    expect(result.text).not.toMatch(/sent to Google/);
  });
});

describe('GROUND-03/04: the operator owns the directory, not the caller', () => {
  it('writes into the first granted root, under the fixed subdirectory, and says which', async () => {
    const result = await granted.callTool('research_ground', { runIds: [RUN] });
    expect(result.text).toContain(corpusRoot);
    expect(result.text).toMatch(/dossier-grounding\//);
    expect(result.text).toMatch(/first directory the operator granted/);
    // The second granted root is untouched: one location, announced.
    expect(result.text).not.toContain(secondRoot);
  });

  it('takes no directory, filename or subdirectory from the caller', async () => {
    const tool = (await granted.listTools()).find((t) => t.name === 'research_ground');
    const schema = JSON.stringify(tool ?? {});
    for (const forbidden of ['dir', 'path', 'directory', 'filename', 'root', 'subdir']) {
      expect(schema).not.toMatch(new RegExp(`"${forbidden}"\\s*:\\s*\\{`));
    }
    // And an argument smuggled in anyway changes nothing: the write still lands
    // in the granted root under the fixed name, because there is no code path
    // that reads a destination from the caller.
    const result = await granted.callTool('research_ground', {
      runIds: [RUN],
      dir: '/etc',
      filename: '../../passwd',
      storeName: 'fileSearchStores/somewhere-else',
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain(join(corpusRoot, 'dossier-grounding', `dossier-run-${RUN}.md`));
    expect(result.text).not.toContain('/etc');
    expect(result.text).not.toContain('passwd');
  });

  // GROUND-08
  it('writes 0600 files inside a 0700 directory', async () => {
    await granted.callTool('research_ground', { runIds: [RUN] });
    const dir = join(corpusRoot, 'dossier-grounding');
    const dirStat = await stat(dir);
    const fileStat = await stat(join(dir, `dossier-run-${RUN}.md`));
    expect(dirStat.mode & 0o777).toBe(0o700);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });
});

describe('GROUND-06: with no root granted, it refuses rather than picking one', () => {
  it('repeats the operator-grant rule and writes nothing', async () => {
    const result = await ungranted.callTool('research_ground', { runIds: [RUN] });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/DOSSIER_LOCAL_CORPUS_DIRS/);
    expect(result.text).toMatch(/no tool that grants one/);
  });
});

describe('GROUND-09: the upload path names the third party', () => {
  it('says in its description that upload sends the report to Google, and is not read-only', async () => {
    const tool = (await granted.listTools()).find((t) => t.name === 'research_ground');
    expect(tool?.description).toMatch(/SENDS THE REPORT TO GOOGLE/);
    expect(tool?.description).toMatch(/Default destination is LOCAL/);
    expect(tool?.annotations?.['readOnlyHint']).toBe(false);
  });

  it('refuses without credentials rather than pretending to upload', async () => {
    const result = await granted.callTool('research_ground', {
      runIds: [RUN],
      destination: 'upload',
      storeName: 'fileSearchStores/abc',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/GEMINI_API_KEY/);
  });

  it('never creates a store implicitly', async () => {
    const tool = (await granted.listTools()).find((t) => t.name === 'research_ground');
    expect(JSON.stringify(tool)).toMatch(/No store is ever created for you/);
  });
});

describe('GROUND-14: a grounded report declares it in its header', () => {
  it('leads every read mode with the declaration and names the prior runs', async () => {
    for (const mode of ['outline', 'summary', 'full'] as const) {
      const result = await granted.callTool('research_read', { runId: GROUNDED, mode });
      expect(result.text).toMatch(/Grounded in prior Dossier output/);
      expect(result.text).toContain(RUN);
      expect(result.text).toMatch(/never independent corroboration/);
    }
  });

  it('leaves an ungrounded report exactly as it was', async () => {
    const result = await granted.callTool('research_read', { runId: RUN, mode: 'outline' });
    expect(result.text).not.toMatch(/Grounded in prior Dossier output/);
  });

  it('writes the declaration into the exported file’s front matter and body', async () => {
    const out = await mkdtemp(join(tmpdir(), 'dossier-export-'));
    try {
      const result = await granted.callTool('research_export', {
        runId: GROUNDED,
        dir: out,
        filename: 'follow-up',
      });
      expect(result.isError).toBe(false);
      const written = await readFile(join(out, 'follow-up.md'), 'utf8');
      expect(written).toMatch(new RegExp(`grounded_in: \\[${RUN}\\]`));
      expect(written).toMatch(/never independent corroboration/);
      expect(written).toMatch(/Grounded in prior Dossier output/);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it('carries the chain into the grounding document it writes', async () => {
    await granted.callTool('research_ground', { runIds: [GROUNDED] });
    const doc = await readFile(
      join(corpusRoot, 'dossier-grounding', `dossier-run-${GROUNDED}.md`),
      'utf8',
    );
    expect(doc).toMatch(/dossier_grounding_document: true/);
    expect(doc).toMatch(new RegExp(`dossier_source: dossier://run/${GROUNDED}`));
    expect(doc).toMatch(new RegExp(`grounded_in: \\[${RUN}\\]`));
    expect(doc).toMatch(/This is a Dossier research report, not a source/);
  });
});

describe('the plan and start handshake carries grounding', () => {
  it('names the grounding in the plan and puts the rule in the prompt', async () => {
    const result = await granted.callTool('research_plan', {
      question: 'Has the p99 picture changed since?',
      groundedInRunIds: [RUN],
    });
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/Grounded in prior Dossier output/);
    expect(result.text).toContain('<prior_research>');
    expect(result.text).toMatch(/never independent corroboration/);
    // The prompt is printed in full, so the anchor rule is checkable from here.
    expect(result.text.lastIndexOf('<prior_research>')).toBeLessThan(
      result.text.lastIndexOf('<core_directive>'),
    );
  });

  it('normalises the grounding the same way in plan and start, so a repeated id still matches', async () => {
    // Found by the self-review, not by a failure: `resolveGrounding`
    // de-duplicates, the count reaches the prompt and the prompt is hashed into
    // the fingerprint. Planning on the raw argument priced a two-run grounding
    // and started a one-run one, and the handshake then refused a request
    // nobody had changed.
    const once = await granted.callTool('research_plan', {
      question: 'Has the p99 picture changed since?',
      groundedInRunIds: [RUN],
    });
    const twice = await granted.callTool('research_plan', {
      question: 'Has the p99 picture changed since?',
      groundedInRunIds: [RUN, RUN],
    });
    const fingerprint = (t: string): string | undefined =>
      /Contract fingerprint\*\*: `([^`]+)`/.exec(t)?.[1];
    expect(fingerprint(once.text)).toBeTruthy();
    expect(fingerprint(twice.text)).toBe(fingerprint(once.text));
  });

  it('refuses a run id that could never be a path, as an answer rather than a fault', async () => {
    const result = await granted.callTool('research_ground', { runIds: ['../../etc/passwd'] });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Invalid run id/);
    // The decisive part: the server is still answering.
    expect((await granted.listTools()).length).toBe(39);
  });

  it('refuses to record a grounding claim naming a run that never completed', async () => {
    const result = await granted.callTool('research_start', {
      question: 'Anything at all',
      groundedInRunIds: [RUNNING],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/not completed/);
  });
});
