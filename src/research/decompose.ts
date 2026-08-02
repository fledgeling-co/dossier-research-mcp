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

/**
 * How hard a task reads: `deep` opens pages, `scan` reads result listings.
 *
 * The distinction is a budget, not a preference. A `deep` task is expected to
 * open two or three sources in full and take notes from the body; a `scan` task
 * reads titles, snippets and dates and stops. Marking everything `deep` spends
 * a worker's whole context on the first index it touches, and marking everything
 * `scan` produces a report assembled entirely from search-result summaries,
 * which is how a loop cites forty pages nobody read.
 */
export type Depth = 'deep' | 'scan';

/**
 * When a task may run.
 *
 * `A` tasks are independent: each targets a different index, none needs another's
 * output, and they can all be dispatched at once. `B` tasks exist because some
 * questions only appear after the first sweep, above all "these two sources
 * disagree, which is right". A `B` task may read the `A` notes and must not
 * start before they are in.
 *
 * Borrowed from the dependency-group structure in daymade's `deep-research`
 * skill (`github.com/daymade/claude-code-skills`), including its concurrency
 * limit.
 */
export type TaskGroup = 'A' | 'B';

/**
 * How many tasks to have in flight at once.
 *
 * Three, from the same source. The ceiling is not about the server, which does
 * no searching: it is about the host. Above three concurrent workers, rate
 * limits on the search backend start returning partial result sets, and a
 * partial result set is indistinguishable from a thin topic, so the loop
 * silently records "not much out there" about a subject with plenty out there.
 */
export const MAX_CONCURRENT_TASKS = 3;

export interface SearchTask {
  readonly id: string;
  /** The expert whose habits this task should imitate. */
  readonly role: string;
  readonly objective: string;
  readonly sourceClass: SourceClass;
  readonly depth: Depth;
  readonly group: TaskGroup;
  /** Task ids that must have reported before this one starts. Empty for group A. */
  readonly dependsOn: readonly string[];
  /** Concrete queries to issue, in the dialect the target index expects. */
  readonly queries: readonly string[];
  /**
   * Tools on this server that reach what a search index cannot. Empty for most
   * classes, because most of the web is indexed and a tool hint that fires
   * everywhere is noise a worker learns to skip.
   */
  readonly tools: readonly string[];
  /** What a good answer to this task looks like, so a worker knows when to stop. */
  readonly done: string;
}

interface ClassStrategy {
  readonly role: string;
  readonly objective: (topic: string) => string;
  readonly queries: (topic: string) => readonly string[];
  readonly depth: Depth;
  readonly tools?: readonly string[];
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
    // Two tools rather than three queries, because both reach places a search
    // index does not: Reddit's `.json` endpoints answer 403, and a video's
    // argument is in its audio, which no index has read.
    tools: [
      '`reddit_gather` reads a community exhaustively in a window. Call it with no subreddits first; it ' +
        'returns the discovery query to run.',
      '`youtube_gather` searches and returns transcripts, above a floor of 30,000 views and 30,000 ' +
        'subscribers. Useful where the practitioner talk is on camera and nowhere else.',
    ],
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
  /**
   * Force every task down to `scan`, whatever it asked for. Beats `deep`.
   *
   * Set when the host has no page fetch. It has to live here rather than being
   * applied by the caller afterwards, because the reconciliation task sets its
   * own depth and would otherwise keep telling a worker to read pages in full on
   * a host that cannot open one.
   */
  readonly scanOnly?: boolean;
  /**
   * Add the group B reconciliation task. Default true.
   *
   * Off when there is too little group A for it to have anything to reconcile,
   * and off in `light` mode, where the whole point is fewer workers.
   */
  readonly reconcile?: boolean;
}

/**
 * The group B task.
 *
 * Its queries cannot be written here, because the thing it searches for is
 * whatever group A disagreed about, and that is not known until group A has
 * reported. So it ships with query *shapes* and is dispatched with the group A
 * registry in hand. This is the one task whose brief is genuinely incomplete at
 * planning time, and pretending otherwise would produce three plausible queries
 * about the topic in general, which group A already ran.
 */
function reconciliationTask(topic: string, dependsOn: readonly string[]): SearchTask {
  return {
    id: 'b1',
    role: 'a fact-checker who starts only once the first sweep is in, and searches the disagreements rather than the topic',
    objective: `Resolve the specific points where the group A sources contradict each other, on: ${topic}`,
    sourceClass: 'general-web',
    depth: 'deep',
    group: 'B',
    dependsOn: [...dependsOn],
    queries: [
      `"<the contested claim, quoted from a group A finding>"`,
      `${topic} "<the contested figure>" correction OR retracted OR updated`,
      `${topic} "<the two disagreeing sources>" which is right`,
    ],
    tools: [],
    done: 'Each contradiction either resolved with a source that settles it, or recorded as genuinely open. An unresolved contradiction is a finding, not a failure.',
  };
}

export function decompose(question: string, opts: DecomposeOptions): SearchTask[] {
  const topic = topicOf(question);
  const classes = BY_ARCHETYPE[opts.archetype].slice(0, opts.maxTasks ?? 5);
  const groupA: SearchTask[] = classes.map((sourceClass, i) => {
    const s = STRATEGIES[sourceClass];
    return {
      id: `t${String(i + 1)}`,
      role: s.role,
      objective: s.objective(topic),
      sourceClass,
      depth: opts.deep ? 'deep' : s.depth,
      group: 'A',
      dependsOn: [],
      queries: s.queries(topic),
      tools: s.tools ?? [],
      done: s.done,
    };
  });
  // Two group A tasks cannot contradict each other in any interesting way, so
  // below three the reconciliation worker is a guaranteed miss and is dropped.
  const wants = opts.reconcile ?? true;
  const tasks =
    !wants || groupA.length < 3
      ? groupA
      : [...groupA, reconciliationTask(topic, groupA.map((t) => t.id))];
  return opts.scanOnly ? tasks.map((t) => ({ ...t, depth: 'scan' as const })) : tasks;
}

/** Render the task list as the instruction a worker actually executes. */
export function renderTasks(tasks: readonly SearchTask[]): string {
  return tasks
    .map((t) =>
      [
        `### ${t.id} · ${t.sourceClass} (${t.depth}, group ${t.group})`,
        '',
        t.dependsOn.length > 0
          ? `**Do not start** until ${t.dependsOn.join(', ')} have reported. You may read their findings first.`
          : '**Independent.** Nothing else has to finish before this one.',
        `**You are** ${t.role}.`,
        `**Find** ${t.objective}`,
        `**Queries** (adapt them once you see results; these are the dialect this index expects):`,
        ...t.queries.map((q) => `- \`${q}\``),
        ...(t.tools.length > 0
          ? ['**Tools that reach what an index cannot** (call these too, not instead):', ...t.tools.map((x) => `- ${x}`)]
          : []),
        t.depth === 'deep'
          ? '**Read in full** two or three of the best sources, and take notes from the body rather than the snippet.'
          : '**Snippets are enough.** Read titles, summaries and dates; do not open every result.',
        `**Done when** ${t.done}`,
      ].join('\n'),
    )
    .join('\n\n');
}

/**
 * The dispatch plan: which tasks go now, and which wait.
 *
 * Returned as waves rather than as a flat list because the ordering is the
 * point, and a caller handed a flat list dispatches all of it.
 */
export function dispatchWaves(tasks: readonly SearchTask[]): SearchTask[][] {
  const a = tasks.filter((t) => t.group === 'A');
  const b = tasks.filter((t) => t.group === 'B');
  const waves: SearchTask[][] = [];
  for (let i = 0; i < a.length; i += MAX_CONCURRENT_TASKS) {
    waves.push(a.slice(i, i + MAX_CONCURRENT_TASKS));
  }
  if (b.length > 0) waves.push(b);
  return waves;
}

/** Render the dispatch plan as the instruction the lead follows. */
export function renderDispatch(tasks: readonly SearchTask[]): string {
  const waves = dispatchWaves(tasks);
  if (waves.length === 0) return '_No tasks._';
  return waves
    .map((wave, i) => {
      const ids = wave.map((t) => `\`${t.id}\``).join(', ');
      const last = i === waves.length - 1 && wave.every((t) => t.group === 'B');
      return last
        ? `${String(i + 1)}. **After every group A task has reported**, dispatch ${ids}. Hand it the registry from \`research_local_note\`'s reply, so it searches the contradictions rather than the topic again.`
        : `${String(i + 1)}. Dispatch ${ids} in parallel, and wait for all of them.`;
    })
    .join('\n');
}
