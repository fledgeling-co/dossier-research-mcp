/**
 * The text layer the accuracy and relevance scorers read.
 *
 * Two jobs, both about *where* a match is allowed to come from rather than what
 * counts as one.
 *
 * **Citations are not prose.** A backend that pastes a URL containing the figure
 * has not reasoned about the figure, and a scorer that matched against the raw
 * markdown would credit it for the accident. `extractProse` removes every
 * citation form `extractCitedUrls` in `src/research/report.ts` recognises,
 * because a figure surviving in any one of them is the same defect wearing a
 * different hat. The two functions are kept in step by a test that reads the
 * forms out of that module's own patterns.
 *
 * **A denied figure is still a figure.** "Revenue was not 1.2 billion" contains
 * `1.2 billion`, and a presence test scores it. That was flagged when the task
 * format shipped and handed to this item explicitly. The rule below is a named
 * cue list scoped to a clause: weaker than a reader, and exact, repeatable and
 * free, which is the same trade this repo already makes for token containment
 * and is reported as exactly that rather than as comprehension.
 *
 * Everything here is pure and synchronous. No model, no network, no filesystem.
 */

/**
 * Strip every citation form, leaving the text a human would read as the report.
 *
 * Order is load-bearing. Link destinations go before the bare-URL sweep, or the
 * sweep consumes the URL inside `[text](url)` and leaves `[text]()` behind, and
 * the reference-definition form has to be recognised at the head of a line
 * before the inline-link pattern gets a chance to read it as one.
 *
 * Link *text* is kept, because "as Reuters reported" is prose the model wrote.
 * The exception is text that is itself a bare hostname or URL, which is this
 * repo's own citation style (`[arxiv.org](https://arxiv.org/...)`): there the
 * visible text is part of the citation and keeping it would let a domain
 * containing digits stand in for a figure.
 *
 * Each removal leaves a space rather than nothing, so two words either side of a
 * stripped citation cannot fuse into a third word that was never written.
 */
export function extractProse(markdown: string): string {
  return (
    markdown
      // 1. `<cite url="...">text</cite>` — the attribute goes, the text stays.
      .replace(/<cite\s+[^>]*>/gi, ' ')
      .replace(/<\/cite\s*>/gi, ' ')
      // 2. Reference definitions at the head of a line: `[label]: https://...`.
      //    Matched first because the inline-link pattern would otherwise read
      //    the label as link text and leave the URL behind.
      .replace(/^[ \t]*\[[^\]]*\]:[ \t]*\S+[ \t]*$/gm, ' ')
      // 3. Images and inline links. The destination always goes; the text stays
      //    unless it is itself a bare hostname or URL.
      .replace(/!?\[([^\]]*)\]\(\s*<?([^)\s]*)>?(?:\s+"[^"]*")?\s*\)/g, (_whole, text: string) =>
        isBareLocator(text) ? ' ' : ` ${text} `,
      )
      // 4. CommonMark autolinks.
      .replace(/<https?:\/\/[^\s<>]*>/gi, ' ')
      // 5. Any bare URL left anywhere else.
      .replace(/https?:\/\/[^\s<>"'|)\]]+/gi, ' ')
  );
}

/**
 * Whether a link's visible text is a locator rather than prose.
 *
 * A hostname has no spaces, at least one dot, and a plausible top-level label.
 * `arxiv.org` and `api.github.com` are locators; `Reuters` and `the 2019 filing`
 * are not. Deliberately narrow: misreading real prose as a citation would delete
 * text the model wrote, which is a false negative in the other direction.
 */
function isBareLocator(text: string): boolean {
  const t = text.trim();
  if (t === '' || /\s/.test(t)) return false;
  if (/^https?:\/\//i.test(t)) return true;
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i.test(t);
}

/**
 * The wording that flips an occurrence's polarity.
 *
 * Exported so a later item can widen it against evidence rather than by editing
 * a literal, and so a disputed score can be argued against the list that
 * produced it.
 *
 * Kept tight on purpose. A bare `no` was tried and rejected: "no fewer than 303
 * questions" is an assertion of 303, and reading it as a denial would invent a
 * false negative in the category the brief says false negatives are most
 * expensive. `no evidence` and `no such` carry the denial explicitly and are
 * safe; `no` alone does not.
 */
export const NEGATION_CUES: readonly string[] = [
  'not',
  'never',
  'cannot',
  "n't",
  'rather than',
  'instead of',
  'contrary to',
  'no evidence',
  'no such',
  'incorrectly',
  'falsely',
  'untrue',
  'debunked',
];

/** How far back from a match a cue may sit and still govern it. */
export const NEGATION_WINDOW_WORDS = 10;

const CLAUSE_BREAKS = new Set(['!', '?', ';', ':', '\n', '\r', '—', '–']);

/**
 * Contrast words that end a negation's reach.
 *
 * "It is not 8.8, but 9.1" must leave `9.1` positive. Without these the cue
 * would govern the whole sentence and deny the figure the report actually
 * asserted, which is the most likely way this rule produces a wrong answer.
 */
const CONTRAST_WORDS = ['but', 'however', 'although', 'though', 'whereas', 'while', 'yet'];

const ALPHANUMERIC = /[\p{L}\p{N}]/u;

/**
 * Where the clause containing `at` begins.
 *
 * A `.` between two digits is not a boundary, or `1.2` would cut its own clause
 * in half and every decimal figure would look like the start of a new thought.
 */
function clauseStart(text: string, at: number): number {
  let start = 0;
  for (let i = 0; i < at; i += 1) {
    const ch = text[i];
    if (ch === undefined) break;
    if (ch === '.') {
      const before = text[i - 1];
      const after = text[i + 1];
      const insideNumber =
        before !== undefined && after !== undefined && /\d/.test(before) && /\d/.test(after);
      if (!insideNumber) start = i + 1;
      continue;
    }
    if (CLAUSE_BREAKS.has(ch)) start = i + 1;
  }
  return start;
}

/** Whether a needle sits at `index` on word boundaries within `text`. */
function boundedAt(text: string, index: number, length: number): boolean {
  const before = index === 0 ? undefined : text[index - 1];
  const after = text[index + length];
  const leftOk = before === undefined || !ALPHANUMERIC.test(before);
  const rightOk = after === undefined || !ALPHANUMERIC.test(after);
  return leftOk && rightOk;
}

/**
 * Whether the occurrence at `at` sits inside a denial.
 *
 * `text` must already be in the scorers' one coordinate system, meaning
 * `normaliseForSearch(extractProse(report))`. The scope is the clause containing
 * the match, further bounded by any contrast word after the cue and by a window
 * of ten words, so a cue at the far end of a long clause does not reach a figure
 * it has nothing to do with.
 *
 * This is a cue list, not comprehension. It cannot see "the claim that revenue
 * reached 1.2 billion is disputed", and it says so in the scorer's notes rather
 * than implying it read the sentence.
 */
export function isNegated(text: string, at: number): boolean {
  const start = clauseStart(text, at);
  const before = text.slice(start, at);
  if (before.trim() === '') return false;

  // Words between a candidate cue and the match, so a cue may be discounted for
  // being too far away without re-splitting the clause per cue.
  const wordStarts: number[] = [];
  for (const m of before.matchAll(/[\p{L}\p{N}']+/gu)) wordStarts.push(m.index);

  let negated = false;
  for (const cue of NEGATION_CUES) {
    let idx = before.indexOf(cue);
    while (idx !== -1) {
      // `n't` is a suffix, so it is allowed to sit against the word it contracts.
      const bounded = cue.startsWith("n'") ? true : boundedAt(before, idx, cue.length);
      if (bounded) {
        const cueEnd = idx + cue.length;
        const wordsAfter = wordStarts.filter((w) => w >= cueEnd).length;
        const contrastAfter = CONTRAST_WORDS.some((w) => {
          let c = before.indexOf(w, cueEnd);
          while (c !== -1) {
            if (boundedAt(before, c, w.length)) return true;
            c = before.indexOf(w, c + 1);
          }
          return false;
        });
        if (wordsAfter <= NEGATION_WINDOW_WORDS && !contrastAfter) negated = true;
      }
      if (negated) break;
      idx = before.indexOf(cue, idx + 1);
    }
    if (negated) break;
  }
  return negated;
}
