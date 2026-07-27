import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  JUDGE_SYSTEM_PROMPT,
  MAX_CLAIM_CHARS,
  MAX_PAGE_CHARS,
  judgePass,
  judgePrompt,
  parseJudgement,
} from './judge.js';
import type { LoadedSupportCase } from './corpus.js';

/**
 * The judged pass, exercised with the model replaced by a function.
 *
 * Every test here injects `ask`, so the gate never spawns a process and never
 * spends a quota. The one thing that cannot be injected is whether the question
 * being asked is the product's own question, and that is what the parity test
 * below pins.
 */

function supportCase(id: string, claim: string, pageText: string): LoadedSupportCase {
  return {
    id,
    file: `${id}.yaml`,
    topic: 'a topic',
    claim,
    url: 'https://example.com/page',
    label: 'supports',
    why: 'a fixture whose reasoning is long enough to satisfy the schema when it is parsed',
    pageText,
    page: {
      provenance: 'captured',
      capturedAt: '2026-07-27',
      verdict: 'live',
      httpStatus: 200,
      truncated: false,
      completeHtml: true,
      textFile: `${id}.txt`,
      textSha256: '0'.repeat(64),
      textChars: pageText.length,
    },
  };
}

describe('SELF-13: the judged pass asks the product’s own question', () => {
  it('the system prompt is the one in src/ai/utility.ts, character for character', () => {
    const utility = readFileSync(new URL('../../../src/ai/utility.ts', import.meta.url), 'utf8');
    // The product writes it as three concatenated string literals. Compared by
    // its sentences rather than by one literal, so a reflow of the source does
    // not fail this while a change of meaning still does.
    for (const sentence of JUDGE_SYSTEM_PROMPT.split('. ').filter((s) => s.length > 30)) {
      expect(utility, sentence.slice(0, 50)).toContain(sentence.replace(/^ +/, ''));
    }
  });

  it('shows the model the same amount of the page the product would', () => {
    const utility = readFileSync(new URL('../../../src/ai/utility.ts', import.meta.url), 'utf8');
    // The product spells one cap with a numeric separator and the other
    // without, so both forms are accepted rather than the test pinning a
    // formatting choice it has no opinion about.
    const literal = (n: number): RegExp =>
      new RegExp(String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '_?'));
    expect(utility).toMatch(new RegExp(`head\\(sourceText, ${literal(MAX_PAGE_CHARS).source}\\)`));
    expect(utility).toMatch(new RegExp(`claim\\.slice\\(0, ${literal(MAX_CLAIM_CHARS).source}\\)`));
  });

  it('truncates a long page and a long claim to those caps', () => {
    const prompt = judgePrompt('c'.repeat(5000), 'p'.repeat(50_000));
    expect(prompt).not.toContain('c'.repeat(MAX_CLAIM_CHARS + 1));
    expect(prompt).not.toContain('p'.repeat(MAX_PAGE_CHARS + 1));
  });

  it('names all five verdicts and tells the model which one is the trap', () => {
    const prompt = judgePrompt('a claim', 'a page');
    for (const verdict of [
      'supports',
      'partially_supports',
      'contradicts',
      'not_addressed',
      'unreadable',
    ]) {
      expect(prompt).toContain(verdict);
    }
    expect(prompt).toMatch(/not `supports`/);
  });
});

describe('parseJudgement', () => {
  it('reads a bare object', () => {
    expect(parseJudgement('{"verdict":"contradicts"}')).toEqual({ verdict: 'contradicts' });
  });

  it('reads the last object when the CLI wraps its answer in prose', () => {
    const output =
      'Let me look at the page. The shape I am after is {"verdict":"x"} in general.\n' +
      'Answer: {"verdict":"not_addressed","quote":"the page says something else"}\n';
    expect(parseJudgement(output)).toEqual({
      verdict: 'not_addressed',
      quote: 'the page says something else',
    });
  });

  it('reads an object nested inside another', () => {
    expect(parseJudgement('{"result":{"verdict":"supports"},"verdict":"supports"}')).toEqual({
      verdict: 'supports',
    });
  });

  it('refuses a verdict outside the five rather than coercing it', () => {
    const parsed = parseJudgement('{"verdict":"probably_fine"}');
    expect(parsed).toMatchObject({ error: expect.stringContaining('outside the five') as unknown });
  });

  it('refuses an answer carrying no object at all', () => {
    expect(parseJudgement('I think the page supports the claim.')).toMatchObject({
      error: expect.stringContaining('no readable JSON object') as unknown,
    });
  });

  it('refuses malformed JSON rather than guessing at it', () => {
    expect(parseJudgement('{"verdict": supports}')).toMatchObject({
      error: expect.any(String) as unknown,
    });
  });

  it('drops an empty quote rather than recording one', () => {
    expect(parseJudgement('{"verdict":"supports","quote":"","note":""}')).toEqual({
      verdict: 'supports',
    });
  });
});

describe('judgePass', () => {
  const cases = [
    supportCase('one', 'a claim', 'a page'),
    supportCase('two', 'another claim', 'another page'),
  ];

  it('records a verdict per case, with the model and the date', async () => {
    const evidence = await judgePass(cases, {
      model: 'a-model',
      note: 'a note',
      judgedAt: '2026-07-27',
      ask: () => Promise.resolve('{"verdict":"supports"}'),
    });
    expect(evidence.model).toBe('a-model');
    expect(evidence.judgedAt).toBe('2026-07-27');
    expect(evidence.verdicts).toHaveLength(2);
    expect(evidence.failures).toHaveLength(0);
  });

  it('records a thrown call as a failure by case id, not as a verdict', async () => {
    const evidence = await judgePass(cases, {
      model: 'a-model',
      note: '',
      judgedAt: '2026-07-27',
      ask: (prompt) =>
        prompt.includes('another claim')
          ? Promise.reject(new Error('the CLI exited 1'))
          : Promise.resolve('{"verdict":"supports"}'),
    });
    expect(evidence.verdicts.map((v) => v.caseId)).toEqual(['one']);
    expect(evidence.failures).toEqual([{ caseId: 'two', error: 'the CLI exited 1' }]);
  });

  it('records an unreadable answer as a failure rather than guessing a verdict', async () => {
    const evidence = await judgePass(cases.slice(0, 1), {
      model: 'a-model',
      note: '',
      judgedAt: '2026-07-27',
      ask: () => Promise.resolve('I am not sure.'),
    });
    expect(evidence.verdicts).toHaveLength(0);
    expect(evidence.failures[0]?.error).toMatch(/no readable JSON object/);
  });

  it('asks once per case, in order', async () => {
    const asked: string[] = [];
    await judgePass(cases, {
      model: 'a-model',
      note: '',
      judgedAt: '2026-07-27',
      ask: (prompt) => {
        asked.push(prompt.includes('another claim') ? 'two' : 'one');
        return Promise.resolve('{"verdict":"supports"}');
      },
    });
    expect(asked).toEqual(['one', 'two']);
  });
});
