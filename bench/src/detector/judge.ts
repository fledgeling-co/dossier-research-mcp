import { spawn } from 'node:child_process';
import { z } from 'zod';
import { SUPPORT_LABELS, type JudgedVerdicts, type SupportLabel } from './schema.js';
import type { LoadedSupportCase } from './corpus.js';

/**
 * The judged pass. **Spends a quota, touches a model, and is never in the gate.**
 *
 * It asks a model the same question `research_verify_claims` asks, records what
 * it answered, and stops. Scoring happens later and offline, over the recorded
 * answers, which is the same split BENCH-03 made between collection and scoring
 * and matters more here: a model call is asynchronous, non-deterministic and
 * billed, and a scorer with any one of those properties cannot be re-run over a
 * stored corpus.
 *
 * Two ways to run it, and the default is the free one. A coding CLI the operator
 * already subscribes to spends quota rather than a metered balance, which is how
 * BENCH-09 fail-checked twenty-seven tasks for nothing, and this repo's routing
 * rule already prefers a subscription already paid for over a metered API. The
 * metered path exists and requires saying so.
 *
 * The caveat that rides on every result from the free path: the CLI is not the
 * utility model the product would call. The number is about a model of that
 * class answering that question, not about the exact model `judgeSupport` would
 * use, and the evidence file records which one answered.
 */

/**
 * The instruction, copied from `src/ai/utility.ts` rather than imported.
 *
 * Imported would be better and is not available: that module reaches the AI SDK
 * at load, and the benchmark's pure half must not. `judge.test.ts` pins this
 * string against the product's source text, so a change there fails here rather
 * than quietly making the benchmark measure a different question.
 */
export const JUDGE_SYSTEM_PROMPT =
  'You check whether a source supports a claim. Judge ONLY from the page text supplied; your own knowledge of the topic is irrelevant and using it defeats the point of the check. ' +
  'A page that is about the right topic but does not contain the specific claim is `not_addressed`, not `supports`, that is the most common failure and the one this check exists to catch. ' +
  'A page whose text is a cookie banner, a login wall or empty is `unreadable`, not `not_addressed`. Quote the deciding sentence verbatim when there is one.';

/**
 * How much page text the model sees.
 *
 * `src/ai/utility.ts` caps the page at 30,000 characters and the claim at 2,000
 * before the call. Matched exactly, because a judged arm shown more of the page
 * than the product shows would be measuring a different tool.
 */
export const MAX_PAGE_CHARS = 30_000;
export const MAX_CLAIM_CHARS = 2_000;

export function judgePrompt(claim: string, pageText: string): string {
  return [
    JUDGE_SYSTEM_PROMPT,
    '',
    'Answer with one JSON object and nothing else, on a single line:',
    '{"verdict":"supports|partially_supports|contradicts|not_addressed|unreadable","quote":"...","note":"..."}',
    '',
    'supports = the page states this claim. partially_supports = it states a weaker or narrower version. contradicts = it states something incompatible. not_addressed = the page is readable but does not contain this claim. unreadable = the text given is not usable (a cookie wall, a login page, an empty body).',
    '',
    `Claim:\n${claim.slice(0, MAX_CLAIM_CHARS)}`,
    '',
    '---',
    '',
    `Page text:\n\n${pageText.slice(0, MAX_PAGE_CHARS)}`,
  ].join('\n');
}

export interface JudgeOne {
  readonly verdict: SupportLabel;
  readonly quote?: string | undefined;
  readonly note?: string | undefined;
}

/**
 * What one judged answer has to be, before it is allowed to become a verdict.
 *
 * The caps are the same ones the corpus schema puts on a recorded verdict, so a
 * model that answers with a page-long note cannot produce an evidence file the
 * loader will then refuse.
 */
const JudgedAnswerSchema = z.object({
  verdict: z.enum(SUPPORT_LABELS),
  quote: z.string().max(1000).optional(),
  note: z.string().max(600).optional(),
});

/**
 * Pull the verdict out of whatever the CLI printed.
 *
 * A CLI answers prose around its JSON as often as not, so the last balanced
 * object in the output is taken rather than the whole body being parsed. A
 * response carrying no readable object is a **failure**, recorded by case id,
 * and never a verdict: guessing at an unparseable answer would put a judgement
 * in the matrix that nobody made.
 */
export function parseJudgement(output: string): JudgeOne | { readonly error: string } {
  const candidates: string[] = [];
  for (let i = 0; i < output.length; i += 1) {
    if (output[i] !== '{') continue;
    let depth = 0;
    for (let j = i; j < output.length; j += 1) {
      const ch = output[j];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          candidates.push(output.slice(i, j + 1));
          break;
        }
      }
    }
  }
  for (const candidate of candidates.reverse()) {
    let raw: unknown;
    try {
      raw = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof raw !== 'object' || raw === null || !('verdict' in raw)) continue;
    // Model output is a trust boundary like any other, so it is Zod-parsed and
    // never narrowed by hand (CP §1). The enum is what refuses a sixth verdict.
    const parsed = JudgedAnswerSchema.safeParse(raw);
    if (!parsed.success) {
      const answered: unknown = raw.verdict;
      const shown = typeof answered === 'string' ? answered.slice(0, 60) : 'something that is not a string';
      return { error: `the model answered a verdict outside the five: ${shown}` };
    }
    const { verdict, quote, note } = parsed.data;
    return {
      verdict,
      ...(quote === undefined || quote === '' ? {} : { quote }),
      ...(note === undefined || note === '' ? {} : { note }),
    };
  }
  return { error: 'the response carried no readable JSON object with a verdict' };
}

export interface CliOptions {
  readonly bin: string;
  readonly timeoutMs: number;
}

/**
 * One prompt to one coding CLI.
 *
 * `spawn` with an argv array and no shell, matching `src/providers/local.ts` and
 * BENCH-09's fail-check runner: the prompt is a page of untrusted text and must
 * never reach a shell.
 */
export function askCli(prompt: string, options: CliOptions): Promise<string> {
  const isCodex = /(^|\/)codex$/.test(options.bin);
  const args = isCodex ? ['exec', prompt] : ['-p', '--', prompt];
  return new Promise((resolve, reject) => {
    const child = spawn(options.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the CLI did not answer within ${String(options.timeoutMs)}ms`));
    }, options.timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString('utf8');
    });
    child.on('error', (e: Error) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`the CLI exited ${String(code)}: ${err.slice(0, 300)}`));
    });
  });
}

export interface JudgePassOptions {
  readonly model: string;
  readonly note: string;
  readonly judgedAt: string;
  readonly ask: (prompt: string) => Promise<string>;
}

/**
 * Run the pass over every case and build the evidence file.
 *
 * Sequential rather than concurrent, because the free path spends a
 * subscription's rate limit and running eight at once is how a quota-backed
 * lane turns into a wall of refusals that then read as an unreliable model.
 */
export async function judgePass(
  cases: readonly LoadedSupportCase[],
  options: JudgePassOptions,
): Promise<JudgedVerdicts> {
  const verdicts: JudgedVerdicts['verdicts'][number][] = [];
  const failures: JudgedVerdicts['failures'][number][] = [];

  for (const supportCase of cases) {
    let output: string;
    try {
      output = await options.ask(judgePrompt(supportCase.claim, supportCase.pageText));
    } catch (e: unknown) {
      failures.push({
        caseId: supportCase.id,
        error: (e instanceof Error ? e.message : 'the judge call failed').slice(0, 600),
      });
      continue;
    }
    const parsed = parseJudgement(output);
    if ('error' in parsed) {
      failures.push({ caseId: supportCase.id, error: parsed.error });
      continue;
    }
    verdicts.push({ caseId: supportCase.id, ...parsed });
  }

  return {
    version: 1,
    model: options.model,
    judgedAt: options.judgedAt,
    note: options.note,
    verdicts,
    failures,
  };
}
