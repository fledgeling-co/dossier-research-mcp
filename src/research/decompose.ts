import type { Archetype } from './archetypes.js';

/**
 * Decomposing a question into search tasks.
 *
 * The local loop's first step, and the one that decides whether the rest of it
 * finds anything. A single query issued five ways finds one neighbourhood of
 * the web five times; five *differently framed* queries against five different
 * source classes find five neighbourhoods.
 *
 * The source-class routing is the load-bearing part. **Searching arXiv the way
 * you search Stack Overflow finds nothing**: an academic index wants a topic and
 * an author, an issue tracker wants an error string, a filings database wants a
 * company and a form number. Issuing one query shape everywhere is the most
 * common way a research loop quietly under-performs, because it still returns
 * results and they still look like results.
 */

export const SOURCE_CLASSES = [
  'official-docs',
  'issue-tracker',
  'academic',
  'filings',
  'community',
  'journalism',
  'general-web',
] as const;
export type SourceClass = (typeof SOURCE_CLASSES)[number];

/** How hard a task reads: `deep` opens pages, `scan` reads result listings. */
export type Depth = 'deep' | 'scan';

export interface SearchTask {
  readonly id: string;
  /** The expert whose habits this task should imitate. */
  readonly role: string;
  readonly objective: string;
  readonly sourceClass: SourceClass;
  readonly depth: Depth;
  /** Concrete queries to issue, in the dialect the target index expects. */
  readonly queries: readonly string[];
  /** What a good answer to this task looks like, so a worker knows when to stop. */
  readonly done: string;
}

interface ClassStrategy {
  readonly role: string;
  readonly objective: (topic: string) => string;
  readonly queries: (topic: string) => readonly string[];
  readonly depth: Depth;
  readonly done: string;
}

/**
 * One query dialect per source class.
 *
 * These are deliberately mechanical. A model asked to "search well" writes
 * plausible queries; a template that knows `site:github.com … is:issue` writes
 * queries that actually reach an issue tracker.
 */
const STRATEGIES: Record<SourceClass, ClassStrategy> = {
  'official-docs': {
    role: 'a technical writer who reads primary documentation before anything else',
    objective: (t) => `What the maintainers claim in their own documentation, on: ${t}`,
    queries: (t) => [`${t} documentation`, `${t} official docs reference`, `${t} changelog release notes`],
    depth: 'deep',
    done: 'A documented statement, with the doc version or date it was published.',
  },
  'issue-tracker': {
    role: 'a maintainer who reads bug reports for what a product actually does under load',
    objective: (t) => `Where it breaks in practice, in the words of people who hit it, on: ${t}`,
    queries: (t) => [
      `site:github.com ${t} is:issue`,
      `site:github.com ${t} "known issue" OR "does not support"`,
      `${t} bug report reproduction`,
    ],
    depth: 'scan',
    done: 'Named issues with their state, and whether a maintainer confirmed them.',
  },
  academic: {
    role: 'a research librarian who searches by topic, method and author rather than by phrase',
    objective: (t) => `Peer-reviewed or preprint work bearing on: ${t}`,
    // Topic-and-venue, never an error string: an academic index has no idea
    // what a stack trace is.
    queries: (t) => [`arxiv ${t}`, `${t} survey OR benchmark paper`, `site:doi.org ${t}`],
    depth: 'deep',
    done: 'Papers with authors, venue and year, and what they measured.',
  },
  filings: {
    role: 'an analyst who reads what a company was legally required to say',
    objective: (t) => `Filed, audited or regulator-published statements on: ${t}`,
    queries: (t) => [`${t} 10-K OR 20-F OR annual report`, `site:sec.gov ${t}`, `${t} regulatory filing disclosure`],
    depth: 'deep',
    done: 'A filing, its date and form type, and the figure as filed.',
  },
  community: {
    role: 'a practitioner reading what users say when no vendor is listening',
    objective: (t) => `Unsanitised first-hand experience of: ${t}`,
    queries: (t) => [
      `site:reddit.com ${t}`,
      `site:news.ycombinator.com ${t}`,
      `${t} "in production" experience review`,
    ],
    depth: 'scan',
    done: 'Direct quotes with dates, and whether the account is first-hand.',
  },
  journalism: {
    role: 'a reporter checking what has been independently verified',
    objective: (t) => `Independent reporting, and who broke it first, on: ${t}`,
    queries: (t) => [`${t} news`, `${t} reported OR announced`, `${t} investigation`],
    depth: 'scan',
    done: 'Outlets, dates, and whether they are reporting independently or repeating one wire story.',
  },
  'general-web': {
    role: 'a generalist checking the obvious answer before assuming a hard one',
    objective: (t) => `The basic, current state of: ${t}`,
    queries: (t) => [t, `${t} comparison`, `${t} 2026`],
    depth: 'scan',
    done: 'The mainstream account, and where it disagrees with itself.',
  },
};

/**
 * Which classes an archetype should sweep.
 *
 * Not every class per question: a regulatory question has nothing to gain from
 * an issue tracker, and dispatching one anyway spends a worker on a guaranteed
 * miss. Ordered by expected yield, since a caller may take the first few.
 */
const BY_ARCHETYPE: Record<Archetype, readonly SourceClass[]> = {
  technical: ['official-docs', 'issue-tracker', 'academic', 'community', 'general-web'],
  competitive: ['filings', 'official-docs', 'community', 'journalism', 'general-web'],
  regulatory: ['filings', 'official-docs', 'journalism', 'academic', 'general-web'],
  academic: ['academic', 'official-docs', 'journalism', 'general-web'],
  forecasting: ['filings', 'journalism', 'academic', 'community', 'general-web'],
};

/**
 * Reduce a question to the terms worth searching for.
 *
 * The result is a noun phrase lifted out of a sentence, so objectives quote it
 * after a colon rather than embedding it mid-clause: "the maintainers of which
 * vector databases support binary quantization themselves claim" is what
 * embedding produces, and it reads as broken English in every task.
 *
 * Crude on purpose. The alternative is a model call, which costs money and adds
 * a failure mode to the one step that must always work; the queries are a
 * starting point for a worker that can see the results and adapt, not a final
 * answer.
 */
export function topicOf(question: string): string {
  const stop = new Set([
    'what', 'which', 'who', 'when', 'where', 'why', 'how', 'is', 'are', 'was', 'were', 'do', 'does', 'did',
    'the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'and', 'or', 'but', 'from', 'about',
    'should', 'would', 'could', 'can', 'will', 'best', 'better', 'good', 'me', 'my', 'we', 'our', 'i',
  ]);
  const words = question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s.+#-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stop.has(w));
  const topic = words.slice(0, 8).join(' ').trim();
  return topic || question.slice(0, 80).trim();
}

export interface DecomposeOptions {
  readonly archetype: Archetype;
  /** How many tasks to produce. Each one is a worker. */
  readonly maxTasks?: number;
  /** Force every task to read pages rather than listings. */
  readonly deep?: boolean;
}

export function decompose(question: string, opts: DecomposeOptions): SearchTask[] {
  const topic = topicOf(question);
  const classes = BY_ARCHETYPE[opts.archetype].slice(0, opts.maxTasks ?? 5);
  return classes.map((sourceClass, i) => {
    const s = STRATEGIES[sourceClass];
    return {
      id: `t${String(i + 1)}`,
      role: s.role,
      objective: s.objective(topic),
      sourceClass,
      depth: opts.deep ? 'deep' : s.depth,
      queries: s.queries(topic),
      done: s.done,
    };
  });
}

/** Render the task list as the instruction a worker actually executes. */
export function renderTasks(tasks: readonly SearchTask[]): string {
  return tasks
    .map((t) =>
      [
        `### ${t.id} · ${t.sourceClass} (${t.depth})`,
        '',
        `**You are** ${t.role}.`,
        `**Find** ${t.objective}`,
        `**Queries** (adapt them once you see results; these are the dialect this index expects):`,
        ...t.queries.map((q) => `- \`${q}\``),
        `**Done when** ${t.done}`,
      ].join('\n'),
    )
    .join('\n\n');
}
