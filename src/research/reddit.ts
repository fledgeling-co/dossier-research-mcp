/**
 * Reddit, without a credential.
 *
 * Reddit's own routes are closed to a tool like this: `create app` returns a
 * policy link and creates nothing, the `.json` endpoints answer 403 to a
 * non-browser agent, and an automated browser is served a network-security
 * block page. All four checked on 29 July 2026 rather than read about.
 *
 * What works is an archive. Arctic Shift is a public Reddit corpus — the
 * successor to Pushshift, and what Reddit research runs on now — and it answers
 * unauthenticated GETs with posts and comments current to the same day.
 *
 * **It is a THIRD PARTY.** Not Reddit, and not this project. A query here goes
 * to whoever operates photon-reddit.com, and that disclosure belongs in the
 * tool's own description rather than a footnote, on the same rule this codebase
 * applies to every backend that costs money. Free is not the same as private.
 *
 * **The shape that matters: it cannot search by topic.** `q=` is rejected
 * outright; it filters by subreddit and time window. So it reads a community
 * exhaustively and cannot tell you which community to read, which is exactly
 * the opposite of what a search index does. The two are stages, not
 * alternatives, and this module implements both halves.
 */

import { z } from 'zod';
import { type Window } from './shapes.js';

/** Where the archive lives. Overridable so a test never reaches the network. */
export const ARCTIC_SHIFT_BASE = 'https://arctic-shift.photon-reddit.com';

/** Hard caps. A research tool must not be able to pull a subreddit's whole history by accident. */
export const MAX_SUBREDDITS = 8;
export const MAX_ITEMS_PER_SUBREDDIT = 400;
const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 20_000;

export const RedditItemSchema = z.object({
  kind: z.enum(['post', 'comment']),
  subreddit: z.string(),
  id: z.string(),
  /** Title for a post, body for a comment. Whichever the item actually has. */
  text: z.string(),
  author: z.string().optional(),
  createdUtc: z.number().int().nonnegative(),
  permalink: z.string().optional(),
  score: z.number().int().optional(),
});
export type RedditItem = z.infer<typeof RedditItemSchema>;

/* ------------------------------------------------------------------ window */

export interface WindowVerdict {
  readonly window: Window;
  /** Why this window, in words, because a silently-chosen range is a silently-wrong answer. */
  readonly why: string;
  /** True when the question said nothing and the default was applied. */
  readonly inferred: boolean;
}

/**
 * Patterns in the order they are tried. First match wins, so the narrow ones
 * lead: "in the last day" must not be caught by the "last ... year" rule.
 *
 * Written out rather than generated, because the mapping from a phrase to a
 * bucket is a judgement each time. "Recently" is 30 days for a fast-moving
 * technical question and would be a decade in a history one; 30 days is chosen
 * because Reddit threads go quiet in weeks and a wider window mostly returns
 * older items that crowd out the new.
 */
const WINDOW_RULES: readonly { readonly re: RegExp; readonly window: Window; readonly why: string }[] = [
  { re: /\b(today|last 24 ?h(?:ours)?|past 24 ?h(?:ours)?|yesterday|right now|breaking)\b/i, window: '24h', why: 'the question asks about today' },
  { re: /\b(this week|last week|past week|last 7 days|past 7 days|last few days)\b/i, window: '7d', why: 'the question asks about the last week' },
  { re: /\b(this month|last month|past month|last 30 days|past 30 days|recently|lately|these days|right ?now)\b/i, window: '30d', why: 'the question asks about the last month' },
  { re: /\b(this quarter|last quarter|past quarter|last 3 months|past 3 months|last 90 days)\b/i, window: '90d', why: 'the question asks about the last quarter' },
  { re: /\b(this year|last year|past year|last 12 months|past 12 months|in 20\d\d)\b/i, window: '1y', why: 'the question names a year or asks about the last year' },
  { re: /\b(all ?time|ever|historically|over the years|since the beginning|of all time)\b/i, window: 'all', why: 'the question asks across all time' },
  { re: /\b(last|past) (\d+) years?\b/i, window: '5y', why: 'the question asks across several years' },
];

/**
 * Pick the time window from the question itself.
 *
 * Defaults to 30 days rather than the server-wide `1y`, and the difference is
 * deliberate. A year of a busy subreddit is tens of thousands of items whose
 * bulk is old, and Reddit discussion decays fast: a thread nobody has replied
 * to in six months is not what "what do people think" is asking about. A caller
 * who wants the long view can say so and gets it.
 */
export function inferWindow(question: string, explicit?: Window): WindowVerdict {
  if (explicit !== undefined) {
    return { window: explicit, why: 'the caller named the window', inferred: false };
  }
  for (const rule of WINDOW_RULES) {
    if (rule.re.test(question)) return { window: rule.window, why: rule.why, inferred: true };
  }
  return {
    window: '30d',
    why: 'the question named no period, and Reddit discussion decays in weeks, so a month is the useful default rather than the server-wide year',
    inferred: true,
  };
}

/** Epoch seconds for the start of a window. `all` has no lower bound. */
export function windowStartEpoch(w: Window, now: Date = new Date()): number | undefined {
  const days: Partial<Record<Window, number>> = { '24h': 1, '7d': 7, '30d': 30, '90d': 90, '1y': 365, '5y': 1825 };
  const d = days[w];
  if (d === undefined) return undefined;
  return Math.floor((now.getTime() - d * 86_400_000) / 1000);
}

/* --------------------------------------------------------------- discovery */

export interface SubredditCandidate {
  readonly name: string;
  readonly comments: number;
  readonly earliestPost: number | undefined;
}

/**
 * Candidate subreddits whose NAME matches a term.
 *
 * Deliberately half an answer, and the tool says so. A prefix search finds
 * `r/vectordatabase` for "vector database" and will never find `r/LocalLLaMA`,
 * where the same argument is happening under a name that shares no substring
 * with the topic. Name-matching is the half a machine can do alone; the other
 * half is a search index, which knows where a subject is discussed rather than
 * what it is called.
 */
export async function discoverByName(
  term: string,
  fetchImpl: typeof fetch = fetch,
  base = ARCTIC_SHIFT_BASE,
): Promise<SubredditCandidate[]> {
  const url = `${base}/api/subreddits/search?subreddit_prefix=${encodeURIComponent(term)}&limit=20`;
  const raw = await getJson(url, fetchImpl);
  const rows = Array.isArray((raw as { data?: unknown })?.data) ? ((raw as { data: unknown[] }).data) : [];
  const out: SubredditCandidate[] = [];
  for (const row of rows) {
    const r = row as { display_name?: unknown; _meta?: { num_comments?: unknown; earliest_post?: unknown } };
    const name = typeof r.display_name === 'string' ? r.display_name : undefined;
    if (name === undefined) continue;
    out.push({
      name,
      comments: typeof r._meta?.num_comments === 'number' ? r._meta.num_comments : 0,
      earliestPost: typeof r._meta?.earliest_post === 'number' ? r._meta.earliest_post : undefined,
    });
  }
  // Busiest first: an empty subreddit with a perfect name is worse than a busy
  // one with an approximate name, because the question is what people said.
  return out.sort((a, b) => b.comments - a.comments);
}

/**
 * Words that are never the subject of a question.
 *
 * Needed because the first version of the discovery stage took every word of
 * four letters or more and prefix-searched each. Asked "what do people think of
 * vector databases lately?", it offered r/Whatcouldgowrong, r/whatisthisthing
 * and r/thinkpad — matches on "what", "think" and "people", ranked to the top
 * by sheer size. That is worse than returning nothing: it looks like an answer.
 */
const STOPWORDS = new Set([
  'what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'why', 'how',
  'about', 'after', 'again', 'against', 'been', 'being', 'best', 'better',
  'between', 'both', 'come', 'compared', 'could', 'currently', 'does', 'doing',
  'down', 'during', 'each', 'from', 'good', 'have', 'having', 'here', 'into',
  'just', 'lately', 'like', 'made', 'make', 'many', 'more', 'most', 'much',
  'must', 'need', 'only', 'other', 'others', 'over', 'people', 'really',
  'recent', 'recently', 'right', 'said', 'same', 'says', 'should', 'since',
  'some', 'still', 'such', 'take', 'than', 'that', 'them', 'then', 'there',
  'these', 'they', 'thing', 'things', 'think', 'this', 'those', 'thoughts',
  'through', 'time', 'used', 'using', 'very', 'want', 'well', 'were', 'whether',
  'will', 'with', 'work', 'working', 'would', 'year', 'years', 'your',
  'anyone', 'everyone', 'someone', 'something', 'anything', 'opinion',
  'opinions', 'experience', 'experiences', 'versus', 'compare', 'comparison',
  // Added when the relevance filter matched a post on "actually". The
  // discovery list was built for subreddit NAMES, where an adverb never
  // appears; filtering post bodies meets far more of the question's grammar,
  // so the common intensifiers and hedges have to go too.
  'actually', 'know', 'knows', 'knew', 'seems', 'seem', 'looks', 'look',
  'give', 'gives', 'getting', 'goes', 'going', 'said', 'says', 'tell',
  'told', 'find', 'found', 'help', 'helps', 'helped', 'better', 'worse',
]);

/**
 * The terms worth prefix-searching, longest first.
 *
 * Two shapes are tried, and the compound is the one that actually works: a
 * subreddit is usually named for a thing without spaces, so "vector databases"
 * finds r/vectordatabase as `vectordatabase` and finds nothing as `vector`
 * alone that is not swamped by every community starting with those letters.
 * Singular forms are tried too, since communities are named `r/vectordatabase`
 * rather than `r/vectordatabases`.
 */
export function discoveryTerms(question: string): string[] {
  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));

  const terms: string[] = [];
  // Adjacent pairs, concatenated, which is how communities are named.
  for (let i = 0; i + 1 < words.length; i += 1) {
    const a = words[i]!;
    const b = words[i + 1]!;
    terms.push(`${a}${b}`, `${a}${singular(b)}`);
  }
  for (const w of words) if (w.length >= 5) terms.push(w, singular(w));
  // Longest first: a longer prefix is a sharper filter, and the ranking below
  // keeps whichever produced real matches.
  return [...new Set(terms)].sort((a, b) => b.length - a.length).slice(0, 6);
}

function singular(w: string): string {
  return w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
}

/** The query a caller should run to find subreddits by SUBJECT rather than by name. */
export function discoveryQuery(question: string): string {
  return `site:reddit.com ${question.trim().replace(/\s+/g, ' ').slice(0, 200)}`;
}

/** Subreddit names appearing in a list of Reddit URLs. */
export function subredditsFromUrls(urls: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const u of urls) {
    const m = /reddit\.com\/r\/([A-Za-z0-9_]{2,21})\b/.exec(u);
    if (m?.[1]) seen.add(m[1]);
  }
  return [...seen];
}

/* ----------------------------------------------------------------- gather */

/**
 * Posts and comments from one subreddit inside a window.
 *
 * Paginates forward on `created_utc`, which is how the archive's own cursor
 * works, and stops on the item cap rather than trusting the far end of a range
 * to arrive. A subreddit that returns nothing is not an error: it is a private,
 * dead or misspelled community, and saying "0 items" beats inventing a reason.
 */
export async function gatherSubreddit(
  subreddit: string,
  startEpoch: number | undefined,
  fetchImpl: typeof fetch = fetch,
  base = ARCTIC_SHIFT_BASE,
  maxItems = MAX_ITEMS_PER_SUBREDDIT,
): Promise<RedditItem[]> {
  const before = Math.floor(Date.now() / 1000);
  const items: RedditItem[] = [];

  for (const kind of ['post', 'comment'] as const) {
    const path = kind === 'post' ? '/api/posts/search' : '/api/comments/search';
    let after = startEpoch ?? 0;
    // Bounded rather than while(true): a cursor that fails to advance would
    // otherwise page forever against someone else's server.
    for (let page = 0; page < Math.ceil(maxItems / PAGE_SIZE) && items.length < maxItems; page += 1) {
      const url =
        `${base}${path}?subreddit=${encodeURIComponent(subreddit)}` +
        `&after=${String(after)}&before=${String(before)}&limit=${String(PAGE_SIZE)}&sort=asc`;
      const raw = await getJson(url, fetchImpl);
      const rows = Array.isArray((raw as { data?: unknown })?.data) ? ((raw as { data: unknown[] }).data) : [];
      if (rows.length === 0) break;

      let newest = after;
      for (const row of rows) {
        const r = row as Record<string, unknown>;
        const created = typeof r['created_utc'] === 'number' ? r['created_utc'] : 0;
        const text = kind === 'post' ? str(r['title']) : str(r['body']);
        const id = str(r['id']);
        // Both are required to identify and quote an item. Missing either means
        // a row shaped differently from the documented one, and a silently
        // coerced placeholder would travel into a report as a real quote.
        if (text === undefined || text === '' || id === undefined) continue;
        items.push({
          kind,
          subreddit,
          id,
          text,
          ...(str(r['author']) === undefined ? {} : { author: str(r['author'])! }),
          createdUtc: created,
          ...(str(r['permalink']) === undefined ? {} : { permalink: str(r['permalink'])! }),
          ...(typeof r['score'] === 'number' ? { score: r['score'] } : {}),
        });
        if (created > newest) newest = created;
        if (items.length >= maxItems) break;
      }
      // Advance past the newest item seen, or by a second when a whole page
      // shares one timestamp, which would otherwise re-request it forever.
      after = newest > after ? newest : after + 1;
    }
  }
  return items;
}

/**
 * A string field, or nothing.
 *
 * `String(x)` on an unexpected object yields `"[object Object]"` and stores it
 * as a Reddit post's title, which then reads as a real finding downstream. This
 * is third-party JSON: a field can be any shape, and the honest answer to an
 * unexpected one is to drop the item rather than to coerce it.
 */
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

async function getJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        // Named rather than disguised. A public archive run by one person is
        // owed an identifiable caller, and pretending to be a browser here
        // would be the behaviour this module refuses on Reddit itself.
        'user-agent': 'dossier-research-mcp (+https://github.com/fledgeling-co/dossier-research-mcp)',
      },
    });
    if (!res.ok) throw new Error(`${String(res.status)} from the Reddit archive`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ----------------------------------------------------------------- filter */

/**
 * Keep the items that are actually about the question.
 *
 * The archive filters by subreddit and time and nothing else, so a gather over
 * a busy community returns everything posted in the window. Reported from real
 * use: a detailed question about a specific supplement returned 2,400 posts
 * from r/Sick about food poisoning, ringworm, and coughing hard enough to fart.
 * Zero relevant.
 *
 * That is not a subreddit-choice problem, it is a missing step. The `question`
 * is right there and was being used only to pick a date range, which reads as
 * topical filtering to anyone who passes one. So it filters now.
 *
 * Deliberately term-overlap rather than anything cleverer. It runs locally with
 * no model call, it is explainable to someone reading the output, and its
 * failure mode is dropping a relevant post rather than inventing a match. The
 * count that was dropped is always reported, so a filter that is too aggressive
 * is visible rather than silent.
 */
export function relevantTo(question: string, items: readonly RedditItem[]): {
  readonly kept: RedditItem[];
  readonly dropped: number;
} {
  const terms = questionTerms(question);
  // Nothing to filter on: a question of pure stopwords would otherwise drop
  // everything, which is worse than the firehose it replaced.
  if (terms.length === 0) return { kept: [...items], dropped: 0 };

  const scored = items
    .map((item) => ({ item, hits: termHits(terms, item.text) }))
    .filter((s) => s.hits > 0)
    // Most matching terms first; a post hitting three of your words beats one
    // hitting a single common one.
    .sort((a, b) => b.hits - a.hits || b.item.createdUtc - a.item.createdUtc);

  return { kept: scored.map((s) => s.item), dropped: items.length - scored.length };
}

/** Salient words from the question, singular and plural, longer ones first. */
function questionTerms(question: string): string[] {
  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 12);
}

/** How many of the question's terms appear in a piece of text. */
function termHits(terms: readonly string[], text: string): number {
  const hay = text.toLowerCase();
  let n = 0;
  for (const t of terms) {
    // Stem-ish: matching the first several characters catches plurals and
    // simple inflections without a stemmer's false positives.
    const stem = t.length > 6 ? t.slice(0, t.length - 1) : t;
    if (hay.includes(stem)) n += 1;
  }
  return n;
}

/* ----------------------------------------------------------------- render */

export interface GatherReport {
  readonly window: WindowVerdict;
  readonly subreddits: readonly string[];
  readonly items: readonly RedditItem[];
  /** Subreddits asked for that returned nothing at all. */
  readonly empty: readonly string[];
  /** Items gathered then dropped as unrelated to the question. */
  readonly dropped: number;
}

export function renderGather(report: GatherReport, question: string): string {
  const { window, items, subreddits, empty } = report;
  const byS = new Map<string, number>();
  for (const i of items) byS.set(i.subreddit, (byS.get(i.subreddit) ?? 0) + 1);

  const lines = [
    `### Reddit, ${window.window} window`,
    '',
    `**${String(items.length)} items** from ${String(subreddits.length)} subreddit(s). ` +
      `Window: ${window.window} — ${window.why}.`,
    ...(report.dropped > 0
      ? [
          '',
          `${String(report.dropped)} further item(s) were gathered and dropped as unrelated to the question. ` +
            'The archive filters by subreddit and time only, so everything posted in the window comes back; ' +
            'the question is what narrows it. If the count above looks too small, the filter was too tight ' +
            'and a broader question widens it.',
        ]
      : []),
    '',
    'Source: Arctic Shift, a public Reddit archive. **Not Reddit, and not this project** — the query went to ' +
      'whoever operates photon-reddit.com. No credential was used and none exists to use: Reddit closed ' +
      'self-serve API registration, so the archive is the route rather than a shortcut around one.',
    '',
  ];

  if (byS.size > 0) {
    lines.push('**Per subreddit:**');
    for (const [s, n] of [...byS.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`- r/${s}: ${String(n)} items`);
    }
    lines.push('');
  }
  if (empty.length > 0) {
    lines.push(
      `> [!NOTE]\n> ${empty.map((s) => `r/${s}`).join(', ')} returned nothing in this window. ` +
        'That is a real result — a quiet, private or misspelled community — not a failure, and it is named ' +
        'rather than averaged into the total.',
      '',
    );
  }
  if (items.length === 0) {
    lines.push(
      '**Nothing was found.** Widen the window, or find the right communities first: ' +
        `\`${discoveryQuery(question)}\`. Name matching alone misses a subreddit whose name shares nothing ` +
        'with the subject, which is most of them.',
    );
  }
  return lines.join('\n');
}
