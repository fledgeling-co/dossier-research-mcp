import { z } from 'zod';
import { WINDOWS } from '../../../src/research/shapes.js';

/**
 * The benchmark task format.
 *
 * One YAML file per task under `bench/tasks/`. This schema is the contract every
 * scorer reads and every task author writes against, so it is documentation as
 * much as it is code — the comments explain why a rule exists, because the next
 * reader is somebody hand-writing the hundredth gold set at midnight.
 *
 * Two properties shape every decision here.
 *
 * **No model in the scoring loop.** Every score is computed by code from a gold
 * set fixed before the run. A task is admissible only if its correct answer can
 * be checked by a string, a number, a set membership or an HTTP request. So the
 * format has to carry enough that accuracy, relevance, due weight, calibration
 * and refusal are all decidable mechanically. Where a category could not be
 * decided from the brief's original field list, the missing field is here and
 * the comment says which failure it exists to prevent.
 *
 * **A malformed task is fatal, never skipped.** This is the deliberate opposite
 * of the store's rule in `CLAUDE.md`, where a malformed *item* is skipped so one
 * bad record cannot break a listing. A corpus that quietly drops a task reports
 * a score over a sample nobody chose, which is worse than no score at all. Every
 * object is therefore a `z.strictObject`: a misspelt field is a loud failure,
 * not a silently ignored line, because a task scored on less than its author
 * wrote is exactly the same defect wearing a smaller hat.
 */

/**
 * The ten categories from `docs/plan/benchmark.md`, each separating something
 * different. Kept as a tuple so the union, the enum and any exhaustive switch
 * downstream all derive from one source.
 */
export const TASK_CATEGORIES = [
  'time-bound', // enforced date windows from asked-for ones
  'enumeration', // matrix completeness; every cell filled or explicitly unknown
  'legal-regulatory', // precision and official-source reliance
  'primary-literature', // real DOIs, and reading past the abstract
  'social-sentiment', // the only category where X access matters
  'technical', // issue trackers, changelogs, version specifics
  'obscure-entity', // the black box: correctly reporting nothing found
  'false-premise', // refusing a fabricated presupposition
  'contested', // due weight, both figures, dissent retention
  'settled-with-fringe', // the false-balance counterweight
] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export const GOLD_FACT_KINDS = ['number', 'date', 'name', 'identifier'] as const;
export type GoldFactKind = (typeof GOLD_FACT_KINDS)[number];

/**
 * Six months, in days.
 *
 * Expressed in days rather than calendar months so the horizon has no
 * month-length edge case: subtracting six calendar months from 31 August lands
 * on a date February does not have, and the overflow silently moves the
 * boundary. 183 is also already this repo's encoding of six months —
 * `assessStaleness` in `src/research/evidence.ts` uses it as the stale horizon
 * for journalism — so the benchmark reuses the number rather than introducing a
 * second, subtly different definition of the same period.
 */
export const STALE_AFTER_DAYS = 183;

/**
 * A cap on one task file, not on the corpus.
 *
 * A gold set is a page of YAML. Anything approaching a quarter of a megabyte is
 * a mistake — a pasted report, a committed binary, a runaway generator — and
 * reading it into the parser to find out is the wrong order.
 */
export const MAX_TASK_FILE_BYTES = 262_144;

/** Answers a task may carry without a grid. The design document's figure. */
export const MAX_FLAT_GOLD_FACTS = 10;

/**
 * Answers a task may carry *with* a grid.
 *
 * A three-by-four grid is already twelve cells, so the flat ceiling above would
 * make the enumeration category unable to test the one thing it exists to test.
 * This widens a number `docs/plan/benchmark.md` states flatly as one to ten; the
 * widening is deliberate and is recorded in the spec rather than left to be
 * discovered while hand-writing the corpus.
 */
export const MAX_GRID_GOLD_FACTS = 200;

const slug = (max: number): z.ZodString =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be a lowercase slug: letters, digits and single hyphens');

/** A short piece of author-written text. Capped, like every string here (CP §1). */
const term = (max = 200): z.ZodString => z.string().min(1).max(max);

/**
 * Where an answer came from.
 *
 * A bare link is not enough. BENCH-09 has to confirm, by script, that each gold
 * fact is really present in its cited source on the day it was authored, and a
 * link to a forty-page filing cannot support that. `quote` is the sentence the
 * author read; `locator` is where in the document it sits. Both optional,
 * because a short page needs neither, and both are what makes a disputed score
 * adjudicable against the source rather than against the author's memory.
 *
 * The protocol is pinned to http and https. A `file:` or `data:` source is not
 * something a second person can check.
 */
export const SourceRefSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }).max(2000),
  quote: z.string().min(1).max(1000).optional(),
  locator: z.string().min(1).max(200).optional(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

/**
 * How close a reported number has to be.
 *
 * Every arm names its payload differently on purpose. A shared `value` field
 * across `absolute` and `relative` reads fine and is genuinely ambiguous: is
 * `relative: 1` one percent or everything? That ambiguity does not fail a
 * parse, it silently changes every numeric score in the suite. `fraction`
 * cannot be misread as a percentage, and `digits` cannot be misread as either.
 *
 * `exact` carries no payload and is a deliberate choice rather than an omission,
 * which is what lets the acceptance rule be "a number always states a
 * tolerance" instead of "a number usually states a tolerance".
 */
export const ToleranceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('exact') }),
  z.strictObject({ kind: z.literal('absolute'), value: z.number().positive() }),
  z.strictObject({
    kind: z.literal('relative'),
    /** A fraction, not a percentage: 0.01 is one percent. */
    fraction: z.number().positive().max(1),
  }),
  z.strictObject({
    kind: z.literal('significantFigures'),
    digits: z.number().int().min(1).max(15),
  }),
]);
export type Tolerance = z.infer<typeof ToleranceSchema>;

/** Which cell of a task's grid an answer belongs to. */
export const CellRefSchema = z.strictObject({
  entity: term(200),
  field: term(80),
});
export type CellRef = z.infer<typeof CellRefSchema>;

const goldFactBase = {
  /**
   * Stable within the task, and the reason it is required rather than optional.
   *
   * Without it an answer is only "the third one", which changes meaning the
   * moment somebody inserts an answer above it — so a result stored today
   * cannot be re-scored against the same corpus in six months, which is the
   * whole point of storing raw reports. It is also the only thing a confidence
   * marker in a report can be paired against, and calibration is unscoreable
   * without that pairing.
   */
  id: slug(64),
  /** A human-readable name, for scorecards. Optional; the id is the identity. */
  label: z.string().min(1).max(200).optional(),
  source: SourceRefSchema,
  /** Set only on a task that declares a grid; enforced in the cross-field rules. */
  cell: CellRefSchema.optional(),
};

/**
 * One answer a correct report must contain.
 *
 * A discriminated union rather than one object with optional fields, because
 * that is what makes two acceptance rules structural instead of remembered:
 * `tolerance` and `unit` are **required members of the number arm**, so a
 * numeric answer without either is a parse error at a named path rather than
 * something a scorer has to check and could forget to. Comparing floats exactly
 * is how a correct answer scores zero, and a right figure in the wrong unit has
 * to score zero, which is only possible if the right unit was written down.
 *
 * `aliases` exists on the two string arms and not on the others. A report saying
 * "Meta" where the gold says "Meta Platforms, Inc." is right, and scoring it
 * wrong is a false negative that makes every backend look worse — the exact
 * failure BENCH-04 warns about. Numbers do not need aliases because number
 * formatting is a normalisation problem the accuracy scorer owns, and dates do
 * not because dates parse.
 */
export const GoldFactSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...goldFactBase,
    kind: z.literal('number'),
    value: z.number(),
    /**
     * Required. Write `dimensionless` for a pure count or ratio — an explicit
     * declaration, so "no unit" is a decision the author made rather than a
     * field they skipped.
     */
    unit: term(50),
    tolerance: ToleranceSchema,
  }),
  z.strictObject({
    ...goldFactBase,
    kind: z.literal('date'),
    /** `YYYY-MM-DD`, validated as a real calendar date. */
    value: z.iso.date(),
  }),
  z.strictObject({
    ...goldFactBase,
    kind: z.literal('name'),
    value: term(500),
    aliases: z.array(term(200)).max(20).default([]),
  }),
  z.strictObject({
    ...goldFactBase,
    kind: z.literal('identifier'),
    value: term(500),
    aliases: z.array(term(200)).max(20).default([]),
  }),
]);
export type GoldFact = z.infer<typeof GoldFactSchema>;

/**
 * The numeric arm on its own, for conflicting figures.
 *
 * Derived from the union's own option rather than redeclared, so the two cannot
 * drift apart, with `cell` omitted. A conflicting figure is a disagreeing pair,
 * never an answer to a grid cell, and leaving `cell` on it created a hole: the
 * grid-coverage rule only walks top-level answers, so a nested value could carry
 * a duplicate, undeclared or grid-less cell tag that nothing rejected. Removing
 * the field removes the class instead of testing around it.
 */
export const NumericGoldFactSchema = GoldFactSchema.options[0];
export const ConflictingValueSchema = NumericGoldFactSchema.omit({ cell: true });

/** A documented dissenting position, recorded so due weight can be checked. */
export const KnownDissentSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }).max(2000),
  /**
   * A term the dissenting source uses that the consensus material does not.
   * Matched literally: a report merely using a synonym does not score recall,
   * and that limit is stated in the scorer's output rather than hidden.
   */
  distinguishingTerm: term(200),
});
export type KnownDissent = z.infer<typeof KnownDissentSchema>;

/**
 * Two or more authoritative values for the same quantity.
 *
 * Numeric only. The design calls these conflicting *figures* and BENCH-05 scores
 * them by looking for both numbers in the report, so a name or a date here would
 * be a value with no defined comparison. Each value carries its own tolerance
 * and its own source, because the disagreement is only interesting if both sides
 * are attributable.
 */
export const ConflictingFigureSchema = z.strictObject({
  quantity: term(300),
  values: z.array(ConflictingValueSchema).min(2).max(10),
});
export type ConflictingValue = z.infer<typeof ConflictingValueSchema>;
export type ConflictingFigure = z.infer<typeof ConflictingFigureSchema>;

/**
 * A documented fringe claim on a question that is genuinely settled.
 *
 * The counterweight that stops the due-weight metric rewarding indiscriminate
 * hedging: a backend presenting every question as contested would otherwise
 * score perfectly on dissent recall and be useless.
 *
 * `rejectionCues` is what makes the category scoreable at all. Mentioning a
 * fringe claim in order to dismiss it is the *correct* behaviour and, on a bare
 * string search, is indistinguishable from presenting it as contested. So the
 * author records the wording that marks a rejection, and the scorer can ask
 * whether the fringe term appeared without one. Weaker than a reader's
 * judgement, and exact, repeatable and free — the same trade as token
 * containment, and reported as what it is.
 */
export const FringeClaimSchema = z.strictObject({
  claim: z.string().min(1).max(1000),
  distinguishingTerm: term(200),
  source: SourceRefSchema,
  rejectionCues: z.array(term(200)).max(30).default([]),
});
export type FringeClaim = z.infer<typeof FringeClaimSchema>;

/**
 * The two families where the correct answer is not an answer.
 *
 * `acknowledgementTerms` is required on **both** arms, which is the polarity
 * fix. Checking only that a fabricated name is absent cannot distinguish a
 * report that asserted the fabrication from one that corrected it: both contain
 * the name. The positive signal — wording that shows the report pushed back — is
 * what makes the check decidable.
 */
export const ExpectedRefusalSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('false-premise'),
    /** The fabricated entity or date that must not be asserted. */
    fabricatedTerms: z.array(term(200)).min(1).max(20),
    /** Wording that shows the report rejected the premise. */
    acknowledgementTerms: z.array(term(200)).min(1).max(20),
  }),
  z.strictObject({
    kind: z.literal('no-public-footprint'),
    /** Wording that shows the report said it found nothing. */
    acknowledgementTerms: z.array(term(200)).min(1).max(20),
  }),
]);
export type ExpectedRefusal = z.infer<typeof ExpectedRefusalSchema>;

/**
 * The grid an enumeration task is asking to be filled.
 *
 * Entities and fields must each be free of duplicates: two identically-named
 * rows collapse onto one cell key, so an apparently complete grid would cover
 * fewer distinct cells than it declares, and the completeness check would pass
 * on a grid that is not complete.
 */
export const EnumerationSchema = z.strictObject({
  entities: z.array(term(200)).min(2).max(40),
  fields: z.array(term(80)).min(1).max(20),
  /**
   * Cells the gold set says are genuinely not publicly available. Declaring them
   * is what makes "every cell filled or explicitly marked unknown" a check
   * rather than an aspiration: a report that invents a value for one of these is
   * wrong, and a report that says it could not find it is right.
   */
  unknownCells: z.array(CellRefSchema).max(800).default([]),
});
export type Enumeration = z.infer<typeof EnumerationSchema>;

/**
 * A cell's identity as one string.
 *
 * JSON rather than a delimiter: an entity or field label is author-written text
 * and any separator character could legitimately appear inside one, so joining
 * on a character risks two different cells colliding on one key. A control
 * character would be unambiguous and is banned outright by `npm run lint:source`
 * (a NUL in a string literal shipped once and made the file binary to git and
 * invisible to grep), so encoding is the honest way to get the same property.
 */
const cellKey = (c: CellRef): string => JSON.stringify([c.entity, c.field]);

const hasDuplicate = (values: readonly string[]): string | null => {
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) return v;
    seen.add(v);
  }
  return null;
};

/** Whole UTC days since the epoch, so a time of day can never shift the answer. */
export function utcDayOrdinal(date: Date): number {
  return Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 86_400_000,
  );
}

/** Parse a `YYYY-MM-DD` string that has already passed `z.iso.date()`. */
export function utcDayOrdinalFromIsoDate(iso: string): number {
  return Math.floor(Date.parse(`${iso}T00:00:00.000Z`) / 86_400_000);
}

/**
 * The task schema, as a factory over the reference date.
 *
 * `now` is a parameter rather than something read from the clock inside,
 * because "a human has not checked this in the future" is a cross-field rule
 * like any other and belongs in the same place as the rest of them. Passing it
 * in is also what keeps the whole loader pure: the same corpus and the same
 * reference date produce the same result, twice, on any machine.
 */
export function taskFileSchema(now: Date): z.ZodType<BenchTaskFile> {
  // An Invalid Date makes every comparison below `false`, which would silently
  // disable the future-date rule rather than failing. CP §6.14: guard
  // `new Date(externalInput)` at the boundary rather than letting a poisoned
  // value flow downstream.
  if (Number.isNaN(now.getTime())) {
    throw new TypeError('taskFileSchema needs a valid reference date; received an Invalid Date');
  }
  const nowDay = utcDayOrdinal(now);

  return z
    .strictObject({
      id: slug(100),
      category: z.enum(TASK_CATEGORIES),
      question: z.string().min(10).max(2000),
      /**
       * The date the gold was true. Deliberately unconstrained relative to the
       * reference date: a rule that takes effect on a future date is a
       * legitimate gold fact, and rejecting it would rule out a whole class of
       * regulatory task for no benefit.
       */
      asOf: z.iso.date(),
      /**
       * When a human last checked it. Not the same date as `asOf` and never
       * collapsed into it: a fact can be true as of 2019 and confirmed still
       * true last week, and only the second date says anything about rot.
       */
      reverifiedAt: z.iso.date(),
      /**
       * What this task is *about*, as a slug, for clustering the statistics.
       *
       * Added after the design of record was amended on 27 July 2026: reporting
       * a paired difference over a corpus of ten categories of ten related
       * tasks needs clustered standard errors, because tasks sharing a subject
       * are not independent samples and treating them as such can understate
       * the error by up to a factor of three. The cluster key has to live on the
       * task, and nothing else here can carry it: `category` is what a task
       * *tests*, which is a coarser and different thing from what it is about.
       *
       * Optional. A task that does not set one clusters by its category, which
       * is the honest fallback rather than treating it as its own cluster.
       */
      topic: slug(80).optional(),
      /**
       * The time window the question should be asked over.
       *
       * Request shaping, read by the run harness and by no scorer. It sits here
       * because two of the ten categories are defined by it and there is nowhere
       * else it can live. It is interpreted relative to the task's `asOf`, not
       * to the clock at run time, or the same task asks a different question
       * every month and the benchmark stops being reproducible. What a provider
       * actually *enforced*, as opposed to was asked for, is a property of the
       * run and belongs to the harness.
       */
      window: z.enum(WINDOWS).optional(),
      goldFacts: z.array(GoldFactSchema).max(MAX_GRID_GOLD_FACTS).default([]),
      /** Terms a competent answer cannot avoid using. */
      requiredTerms: z.array(term(200)).max(50).default([]),
      /** Terms indicating the answer wandered into an adjacent topic. */
      driftTerms: z.array(term(200)).max(50).default([]),
      knownDissent: z.array(KnownDissentSchema).max(20).default([]),
      conflictingFigures: z.array(ConflictingFigureSchema).max(20).default([]),
      fringeClaims: z.array(FringeClaimSchema).max(20).default([]),
      expectedRefusal: ExpectedRefusalSchema.optional(),
      enumeration: EnumerationSchema.optional(),
    })
    .superRefine((task, ctx) => {
      // 1. A human cannot have checked a fact in the future.
      if (utcDayOrdinalFromIsoDate(task.reverifiedAt) > nowDay) {
        ctx.addIssue({
          code: 'custom',
          path: ['reverifiedAt'],
          message: 'is in the future; a human cannot have re-verified a fact that has not happened',
        });
      }

      // 2. Every recorded value is addressable, so a scorer can name it and a
      //    confidence marker can be paired against it. Nested conflicting values
      //    share the namespace: they are values a report may state, and two
      //    things a report may state must not share one id.
      const allIds = [
        ...task.goldFacts.map((f) => f.id),
        ...task.conflictingFigures.flatMap((c) => c.values.map((v) => v.id)),
      ];
      const duplicateId = hasDuplicate(allIds);
      if (duplicateId !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['goldFacts'],
          message: `gold fact id "${duplicateId}" is used more than once in this task`,
        });
      }

      // 3. The answer count. Values nested under conflicting figures are the
      //    disagreeing pair rather than answers, so they sit outside this
      //    ceiling while staying inside the uniqueness rule above.
      const ceiling = task.enumeration ? MAX_GRID_GOLD_FACTS : MAX_FLAT_GOLD_FACTS;
      if (task.goldFacts.length > ceiling) {
        ctx.addIssue({
          code: 'custom',
          path: ['goldFacts'],
          message: task.enumeration
            ? `a task may carry at most ${String(MAX_GRID_GOLD_FACTS)} gold facts`
            : `a task without an enumeration grid may carry at most ${String(MAX_FLAT_GOLD_FACTS)} gold facts`,
        });
      }
      if (!task.expectedRefusal && task.goldFacts.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['goldFacts'],
          message:
            'a task must carry at least one gold fact unless it declares an expectedRefusal; otherwise there is nothing to score',
        });
      }

      // 4. A refusal belongs to the two categories that expect one, and its kind
      //    has to match, or the task cannot be scored in its own category and
      //    would silently drag that category's number down.
      const refusalCategory: Partial<Record<TaskCategory, ExpectedRefusal['kind']>> = {
        'false-premise': 'false-premise',
        'obscure-entity': 'no-public-footprint',
      };
      const expectedKind = refusalCategory[task.category];
      if (task.expectedRefusal && expectedKind === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['expectedRefusal'],
          message: `category "${task.category}" does not expect a refusal; only false-premise and obscure-entity do`,
        });
      }
      if (!task.expectedRefusal && expectedKind !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['expectedRefusal'],
          message: `category "${task.category}" must declare an expectedRefusal of kind "${expectedKind}"`,
        });
      }
      if (task.expectedRefusal && expectedKind !== undefined && task.expectedRefusal.kind !== expectedKind) {
        ctx.addIssue({
          code: 'custom',
          path: ['expectedRefusal', 'kind'],
          message: `category "${task.category}" expects a refusal of kind "${expectedKind}"`,
        });
      }

      // 5 and 6. A task whose category promises something it does not record
      //    cannot be scored for the thing that category exists to measure.
      if (
        task.category === 'contested' &&
        task.knownDissent.length === 0 &&
        task.conflictingFigures.length === 0
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['knownDissent'],
          message:
            'a contested task must record knownDissent or conflictingFigures, or there is nothing to check due weight against',
        });
      }
      if (task.category === 'settled-with-fringe' && task.fringeClaims.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['fringeClaims'],
          message:
            'a settled-with-fringe task must record at least one fringeClaim, which is the whole counterweight',
        });
      }

      // 7. The grid.
      if (task.category === 'enumeration' && !task.enumeration) {
        ctx.addIssue({
          code: 'custom',
          path: ['enumeration'],
          message: 'an enumeration task must declare its grid of entities and fields',
        });
      }
      if (task.enumeration) {
        const dupEntity = hasDuplicate(task.enumeration.entities);
        if (dupEntity !== null) {
          ctx.addIssue({
            code: 'custom',
            path: ['enumeration', 'entities'],
            message: `entity "${dupEntity}" is declared more than once; duplicate labels collapse onto one cell`,
          });
        }
        const dupField = hasDuplicate(task.enumeration.fields);
        if (dupField !== null) {
          ctx.addIssue({
            code: 'custom',
            path: ['enumeration', 'fields'],
            message: `field "${dupField}" is declared more than once; duplicate labels collapse onto one cell`,
          });
        }

        const declared = new Map<string, CellRef>();
        for (const entity of task.enumeration.entities) {
          for (const field of task.enumeration.fields) {
            declared.set(cellKey({ entity, field }), { entity, field });
          }
        }

        const covered = new Map<string, number>();
        const noteCell = (cell: CellRef, path: (string | number)[]): void => {
          const key = cellKey(cell);
          if (!declared.has(key)) {
            ctx.addIssue({
              code: 'custom',
              path,
              message: `cell (${cell.entity}, ${cell.field}) names an entity or field the grid does not declare`,
            });
            return;
          }
          const seen = covered.get(key) ?? 0;
          if (seen > 0) {
            ctx.addIssue({
              code: 'custom',
              path,
              message: `cell (${cell.entity}, ${cell.field}) is covered more than once`,
            });
          }
          covered.set(key, seen + 1);
        };

        task.goldFacts.forEach((fact, i) => {
          if (fact.cell) {
            noteCell(fact.cell, ['goldFacts', i, 'cell']);
            return;
          }
          // An untagged answer on a grid task belongs to no cell, so nothing
          // scores it and the completeness count silently disagrees with the
          // number of answers. Rejected rather than ignored.
          ctx.addIssue({
            code: 'custom',
            path: ['goldFacts', i, 'cell'],
            message:
              'a task that declares an enumeration grid must tag every gold fact with the cell it answers',
          });
        });
        task.enumeration.unknownCells.forEach((cell, i) => {
          noteCell(cell, ['enumeration', 'unknownCells', i]);
        });

        for (const [key, cell] of declared) {
          if (!covered.has(key)) {
            ctx.addIssue({
              code: 'custom',
              path: ['enumeration'],
              message: `cell (${cell.entity}, ${cell.field}) is neither answered nor declared unknown; every cell must be one or the other`,
            });
          }
        }
      } else {
        // 8. A cell tag on a task with no grid is an authoring mistake, and a
        //    silent one: the scorer would have nowhere to put the answer.
        task.goldFacts.forEach((fact, i) => {
          if (fact.cell) {
            ctx.addIssue({
              code: 'custom',
              path: ['goldFacts', i, 'cell'],
              message: 'a cell tag requires the task to declare an enumeration grid',
            });
          }
        });
      }
    });
}

/**
 * The parsed shape of one task file.
 *
 * Declared explicitly rather than inferred, because `taskFileSchema` returns a
 * refined schema and naming the output type keeps the contract readable for the
 * nine items that consume it.
 */
export interface BenchTaskFile {
  readonly id: string;
  readonly category: TaskCategory;
  readonly question: string;
  readonly asOf: string;
  readonly reverifiedAt: string;
  readonly topic?: string | undefined;
  readonly window?: (typeof WINDOWS)[number] | undefined;
  readonly goldFacts: readonly GoldFact[];
  readonly requiredTerms: readonly string[];
  readonly driftTerms: readonly string[];
  readonly knownDissent: readonly KnownDissent[];
  readonly conflictingFigures: readonly ConflictingFigure[];
  readonly fringeClaims: readonly FringeClaim[];
  readonly expectedRefusal?: ExpectedRefusal | undefined;
  readonly enumeration?: Enumeration | undefined;
}
