import { z } from 'zod';

/**
 * The artefact shapes a research request can want.
 *
 * Almost every tool in this category assumes **deep** and produces an essay.
 * Three independent sources converged on **wide** being a distinct first-class
 * shape rather than a formatting preference: Perplexity built a preset and a
 * benchmark for it, `Deep-Research-skills` structures its whole workflow as
 * items times fields, and Paperguide's narrative-review flow is an extraction
 * matrix with per-cell source links.
 *
 * The distinction is not cosmetic. When someone asks "which vector databases
 * support binary quantization and what memory do they claim", a beautifully
 * written essay is a failed answer, and one benchmark scored a major provider
 * **zero** for exactly that: returning prose where a table was required.
 */

/** One column of a wide run. */
export const WideFieldSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(80)
    .describe('Column name, e.g. `claimed_memory_10m_vectors`. Machine-ish names extract better than prose questions.'),
  detail: z
    .enum(['brief', 'moderate', 'detailed'])
    .default('brief')
    .describe('How much text this cell should hold. `brief` is a value; `detailed` is a short paragraph.'),
  description: z.string().max(400).optional().describe('What counts as an answer, when the name is not enough.'),
});
export type WideField = z.infer<typeof WideFieldSchema>;

export const WideSpecSchema = z.object({
  topic: z.string().min(3).max(500),
  entities: z
    .array(z.string().min(1).max(200))
    .min(1)
    .max(200)
    .describe('The rows. Supply them when you know them; discovery is a separate, more expensive job.'),
  fields: z.array(WideFieldSchema).min(1).max(40).describe('The columns.'),
});
export type WideSpec = z.infer<typeof WideSpecSchema>;

/**
 * A single filled cell.
 *
 * `uncertain` is per-cell rather than per-report on purpose. A whole-report
 * confidence line tells a reader nothing about *which* number to distrust,
 * which is the only thing they actually want to know before acting on one.
 */
export const WideCellSchema = z.object({
  value: z.string().max(4000),
  uncertain: z.boolean().default(false),
  source: z.string().max(2000).optional(),
});

export const WideRowSchema = z.object({
  entity: z.string(),
  cells: z.record(z.string(), WideCellSchema),
  /** Field names this row could not establish. Empty is a real, useful answer. */
  uncertain: z.array(z.string()).default([]),
});
export type WideRow = z.infer<typeof WideRowSchema>;

/**
 * Render a wide result as markdown.
 *
 * Marks uncertainty inline with `[uncertain]` rather than footnoting it,
 * because a footnote is exactly the thing a reader skimming a table will miss.
 */
export function renderWideTable(spec: WideSpec, rows: readonly WideRow[]): string {
  const cols = spec.fields.map((f) => f.name);
  const header = `| ${['entity', ...cols].join(' | ')} |`;
  const rule = `|${Array(cols.length + 1).fill('---').join('|')}|`;
  const body = rows.map((row) => {
    const cells = cols.map((c) => {
      const cell = row.cells[c];
      if (!cell) return '_not found_';
      const text = cell.value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
      return cell.uncertain ? `${text} \`[uncertain]\`` : text;
    });
    return `| ${[row.entity, ...cells].join(' | ')} |`;
  });

  const gaps = rows.filter((r) => r.uncertain.length > 0);
  const parts = [`## ${spec.topic}`, '', header, rule, ...body];
  if (gaps.length > 0) {
    parts.push(
      '',
      '### What could not be established',
      '',
      // Naming the gaps is the honest counterpart to filling the table. A grid
      // with no holes in it is usually a grid that guessed.
      ...gaps.map((r) => `- **${r.entity}**: ${r.uncertain.join(', ')}`),
    );
  }
  return parts.join('\n');
}

/**
 * Completion gate for a wide run.
 *
 * The run is not done until every declared field is present on every row. Silent
 * omission is the failure this catches: a model that quietly drops the awkward
 * column produces a table that looks complete and is not.
 */
export function validateWide(
  spec: WideSpec,
  rows: readonly WideRow[],
  opts: { readonly requireSources?: boolean } = {},
): string[] {
  const problems: string[] = [];
  const want = new Set(spec.fields.map((f) => f.name));
  const seen = new Set(rows.map((r) => r.entity));
  for (const entity of spec.entities) {
    if (!seen.has(entity)) problems.push(`missing row: ${entity}`);
  }
  for (const row of rows) {
    for (const field of want) {
      const cell = row.cells[field];
      if (!cell && !row.uncertain.includes(field)) {
        problems.push(`${row.entity}: field "${field}" is neither filled nor declared uncertain`);
        continue;
      }
      // The brief requires a source per fact and the gate checked only that
      // something was written, so a wholly uncited matrix passed. Reported
      // rather than enforced by default: a matrix may legitimately cite in its
      // own column rather than in every cell, and refusing that would be the
      // gate deciding a formatting question.
      if (opts.requireSources === true && cell && !cell.uncertain && !cell.source) {
        problems.push(`${row.entity}: field "${field}" asserts a fact with no source`);
      }
    }
  }
  return problems;
}

/**
 * Parse a returned markdown table back into rows.
 *
 * The completion gate is only worth having if it runs against what the model
 * actually returned, and on every backend except Perplexity's native preset the
 * matrix arrives as prose-adjacent markdown rather than a schema-forced object.
 * Parsing is therefore best-effort by necessity: a table it cannot find is
 * reported as an empty result, which `validateWide` then reports as every row
 * missing. Silently returning "no problems" for an unparseable report would
 * invert the whole point of the gate.
 */
/**
 * Cell contents that state "no answer" rather than giving one.
 *
 * Includes `_not found_` because that is what `renderWideTable` writes for a
 * declared gap: parse and render have to agree, or a rendered table read back
 * gains a row of cells whose value is the words "not found".
 */
// The em dash is matched deliberately: a table cell containing one is how a
// model most often writes "no value here", and treating it as a declared gap
// rather than as content is the difference between an honest empty cell and a
// silent hole. It is data being parsed, not prose being written, so the
// no-em-dash writing rule does not apply to it.
const DECLARED_GAP = /^(n\/a|na|unknown|unclear|_?not found_?|none|—|–|-{1,2})$/i;

export function parseWideTable(spec: WideSpec, markdown: string): WideRow[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => /^\s*\|/.test(l) && /\|/.test(l.slice(1)));
  if (start === -1) return [];

  const cells = (line: string): string[] =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      // A cell may legitimately contain an escaped pipe; unescape after split.
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replace(/\\\|/g, '|'));

  const header = cells(lines[start] ?? '');
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  // Map each declared field to whichever column the model chose to name it.
  const columnFor = new Map<string, number>();
  for (const field of spec.fields) {
    const at = header.findIndex((h) => norm(h) === norm(field.name));
    if (at !== -1) columnFor.set(field.name, at);
  }

  const rows: WideRow[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s*\|/.test(line)) break; // the table ended
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // the header rule
    const values = cells(line);
    const entity = values[0] ?? '';
    if (!entity) continue;
    const filled: Record<string, { value: string; uncertain: boolean }> = {};
    const uncertain: string[] = [];
    for (const field of spec.fields) {
      const at = columnFor.get(field.name);
      // A column absent from the header is the silent omission this whole
      // shape exists to catch. It is emphatically NOT the model declaring
      // uncertainty, so it goes in neither list and `validateWide` reports it.
      if (at === undefined) continue;
      const raw = values[at] ?? '';
      const marked = /\[uncertain]/i.test(raw);
      const value = raw.replace(/`?\[uncertain]`?/gi, '').trim();
      if (value === '') {
        // Marked-and-empty is a declaration; empty-and-unmarked is a hole.
        if (marked) uncertain.push(field.name);
        continue;
      }
      if (DECLARED_GAP.test(value)) {
        uncertain.push(field.name);
        continue;
      }
      // Keep the cell's own source when it carries one, so the completion gate
      // can tell a cited fact from a confident assertion.
      const source = /(https?:\/\/[^\s)\]]+)/.exec(raw)?.[1];
      filled[field.name] = { value, uncertain: marked, ...(source ? { source } : {}) };
    }
    rows.push({ entity, cells: filled, uncertain });
  }
  return rows;
}

/**
 * The instruction that turns a matrix request into a prompt.
 *
 * Written for the fallback route, where no schema is enforced and the only
 * lever is the brief itself. Three things are stated as hard requirements
 * because each one is a failure observed in the wild: prose instead of a table,
 * a quietly dropped column, and a confident cell with no source behind it.
 */
export function buildWidePrompt(spec: WideSpec, window: Window = DEFAULT_WINDOW): string {
  const fields = spec.fields
    .map((f) => `- \`${f.name}\` (${f.detail})${f.description ? `: ${f.description}` : ''}`)
    .join('\n');
  return [
    `<core_directive>`,
    `Build a comparison matrix on: ${spec.topic}`,
    `</core_directive>`,
    '',
    '<rows>',
    spec.entities.map((e) => `- ${e}`).join('\n'),
    '</rows>',
    '',
    '<columns>',
    fields,
    '</columns>',
    '',
    '<output_requirements>',
    '1. Return ONE markdown table. The first column is the entity; every column above appears exactly once, spelled exactly as given. Prose instead of a table is a failed answer.',
    '2. Fill every cell for every row. A column you cannot establish for a row is written as `[uncertain]`, never omitted and never guessed.',
    '3. Every cell that asserts a fact carries a source URL, in the cell or in a per-row source column.',
    '4. After the table, list what you could not establish, by row, under the heading "What could not be established".',
    `5. Restrict evidence to the last ${window === 'all' ? 'available period, noting the age of anything older than five years' : window}. State the publication date of anything load-bearing.`,
    '6. Do not add rows that were not requested. Note candidates you noticed under a separate heading instead.',
    '</output_requirements>',
    '',
    '<core_directive>',
    `Build a comparison matrix on: ${spec.topic}. Every requested row, every requested column, cited or marked [uncertain].`,
    '</core_directive>',
  ].join('\n');
}

/** Time windows, generalised past the thirty days most tools assume. */
export const WINDOWS = ['24h', '7d', '30d', '90d', '1y', '5y', 'all'] as const;
export type Window = (typeof WINDOWS)[number];

/** One year, because most research questions are not news. */
export const DEFAULT_WINDOW: Window = '1y';

/**
 * The narrowest recency bucket that still contains the whole window.
 *
 * Deliberately rounds **outward**. A 90-day window has no bucket, and choosing
 * `month` because it is closer would silently discard two thirds of the period
 * the caller asked for. Rounding out to `year` filters nothing valid away and
 * leaves the residual to the prompt, which is the safe direction: a filter that
 * is too wide costs a little relevance, one that is too narrow loses evidence
 * and never says so.
 */
export function windowToRecency(w: Window): string | undefined {
  switch (w) {
    case '24h':
      return 'day';
    case '7d':
      return 'week';
    case '30d':
      return 'month';
    case '90d':
    case '1y':
      return 'year';
    default:
      return undefined; // 5y and all are wider than any bucket on offer
  }
}

/** Whether a bucket matches the window exactly, or merely contains it. */
export function windowIsExactBucket(w: Window): boolean {
  return w === '24h' || w === '7d' || w === '30d' || w === '1y';
}

export function windowToFromDate(w: Window, now = new Date()): string | undefined {
  const days: Partial<Record<Window, number>> = { '24h': 1, '7d': 7, '30d': 30, '90d': 90, '1y': 365, '5y': 1825 };
  const d = days[w];
  if (d === undefined) return undefined;
  return new Date(now.getTime() - d * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Whether a window is enforced or merely requested.
 *
 * A window a backend cannot enforce is a hope expressed in a prompt. Reports
 * must show which it was: "restricted to the last 12 months" means something
 * different on Perplexity than on Gemini, and presenting them identically is a
 * lie of omission.
 *
 * A bucket that merely *contains* the window counts as requested, not enforced.
 * Calling a 90-day window enforced because a one-year filter was applied would
 * be the same lie in a smaller font.
 */
export function windowEnforcement(dateFilter: string, w: Window): 'enforced' | 'requested' {
  if (w === 'all') return 'enforced';
  if (dateFilter === 'range') return 'enforced';
  if (dateFilter === 'recency-bucket') return windowIsExactBucket(w) ? 'enforced' : 'requested';
  return 'requested';
}
