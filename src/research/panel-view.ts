/**
 * What a caller is told about a panel while it runs, and when it finishes.
 *
 * The behaviour this replaces: every member was its own run, and the tools said
 * so, so an agent driving Dossier polled each handle, watched members land one
 * at a time, and reported each to its user as it arrived. That is wrong in a way
 * that is worse than untidy. A panel's whole claim is that support counted across
 * independent backends means something; a member read on its own is a
 * single-sourced finding presented with a panel's authority, and by the time the
 * merge arrives to say "these four agreed because they read the same page", the
 * caller has already reported four findings as corroborated.
 *
 * So a member in an unfinished panel is deliberately NOT presented as something
 * to read. Nothing here hides a member's report; `research_read { runId }` still
 * works and always will, because a caller who has decided to look at one member
 * is entitled to. What changes is that the tools stop inviting it before the
 * evidence is assembled.
 *
 * Pure over records and a clock so the rendering is testable without a store,
 * which is the half that has been wrong twice.
 */

import { estimateDuration } from '../gemini/cost.js';
import type { RunRecord } from '../store/types.js';
import { TERMINAL_STATES } from '../store/types.js';

export interface PanelProgress {
  readonly total: number;
  readonly settled: number;
  readonly allTerminal: boolean;
  /** Minutes until the SLOWEST outstanding member is expected to finish. */
  readonly remainingLowMinutes: number;
  readonly remainingHighMinutes: number;
  /** True when every outstanding member is already past its expected band. */
  readonly overdue: boolean;
}

/**
 * How far along a panel is, and how long the rest is expected to take.
 *
 * The band comes from the provider's own published figures via
 * `estimateDuration`, minus elapsed. Taken as the MAXIMUM across outstanding
 * members rather than an average, because a panel is finished when its slowest
 * member is finished, and an average would promise a time the caller then
 * watches pass.
 */
export function panelProgress(members: readonly RunRecord[], now: number = Date.now()): PanelProgress {
  const total = members.length;
  const settled = members.filter((m) => TERMINAL_STATES.includes(m.state)).length;
  const outstanding = members.filter((m) => !TERMINAL_STATES.includes(m.state));

  let low = 0;
  let high = 0;
  let anyWithinBand = false;
  for (const m of outstanding) {
    const band = estimateDuration({ tier: m.tier });
    const elapsedMin = Math.max(0, (now - Date.parse(m.createdAt)) / 60_000);
    const remLow = Math.max(0, band.lowMinutes - elapsedMin);
    const remHigh = Math.max(0, band.highMinutes - elapsedMin);
    if (remHigh > 0) anyWithinBand = true;
    low = Math.max(low, remLow);
    high = Math.max(high, remHigh);
  }

  return {
    total,
    settled,
    allTerminal: settled === total,
    remainingLowMinutes: Math.round(low),
    remainingHighMinutes: Math.round(high),
    overdue: outstanding.length > 0 && !anyWithinBand,
  };
}

/** The estimate in words, or an honest statement that the band has passed. */
export function describeRemaining(p: PanelProgress): string {
  if (p.allTerminal) return 'every member has settled';
  if (p.overdue) {
    return (
      'past the expected band already, which is not yet a failure: Google caps one task at 60 minutes and the stall ' +
      'watchdog marks a run `stalled` when it stops making forward progress, so a member still `running` here is still working'
    );
  }
  if (p.remainingHighMinutes === 0) return 'due any moment';
  return p.remainingLowMinutes === 0
    ? `up to about ${String(p.remainingHighMinutes)} more minute(s)`
    : `roughly ${String(p.remainingLowMinutes)}-${String(p.remainingHighMinutes)} more minute(s)`;
}

/**
 * The monitor to set up instead of polling by hand.
 *
 * Concrete enough to act on and generic enough to be true in any client: a
 * command that exits when the panel settles, rather than a schedule that fires
 * forever. Two minutes because these runs last 4 to 60, so a tighter interval
 * buys nothing but noise, and the caller's own attention is the resource being
 * spent while a panel runs.
 */
export function monitorAdvice(panelId: string, anchorRunId: string): string[] {
  return [
    '**Set up a monitor rather than polling by hand.** Check every two minutes and tell the user how it is going; a panel',
    'runs for 4 to 60 minutes and there is nothing to do in between. What to watch:',
    '',
    `- \`research_status\` with no arguments: every in-flight run grouped by panel, each with its TIME REMAINING. This is the one to poll.`,
    `- \`research_status { runId: "${anchorRunId}" }\`: the same estimate for this panel alone, plus live progress counters.`,
    `- \`research_tail { runId, sinceSeq }\`: new events only, so a two-minute check costs almost no context.`,
    '',
    `Report the time remaining to the user, and say when it changes. Do NOT report findings from a member that has`,
    `finished while others are still running, and do not read a member's report to fill the wait: an early member read alone`,
    `is a single-sourced finding, and reporting it before the merge is how it gets described as corroborated when it is not.`,
    `Panel \`${panelId}\` merges itself the moment its last member settles.`,
  ];
}

/**
 * What to say about a member whose panel has not finished.
 *
 * Returns nothing for a run that is not in a panel, and nothing once the panel
 * is complete, so the caller of this function does not have to know which case
 * it is in.
 */
export function renderPanelWaiting(
  members: readonly RunRecord[],
  panelId: string,
  now: number = Date.now(),
): string[] {
  if (members.length < 2) return [];
  const p = panelProgress(members, now);
  if (p.allTerminal) return [];

  const anchor = members[0];
  return [
    '',
    `> [!IMPORTANT]`,
    `> **This run is member ${String(p.settled + 1)} of ${String(p.total)} in panel \`${panelId}\`, which is not finished.** ` +
      `${String(p.settled)} of ${String(p.total)} members have settled; the rest are ${describeRemaining(p)}.`,
    `>`,
    `> There is nothing to report to the user yet beyond progress. A single member's report is one backend's answer, and a panel ` +
      `exists because support counted across INDEPENDENT backends means something that one backend's confidence does not. ` +
      `Wait for the merge, which arrives automatically and free when the last member settles.`,
    '',
    ...monitorAdvice(panelId, anchor?.id ?? ''),
  ];
}

/**
 * What to say when every member has settled.
 *
 * All of it at once, which is the point: the outcome of every member, then the
 * merge, then what to actually do with it. The reading guidance is here rather
 * than in a doc because this is the moment a caller decides whether to read
 * properly or skim a summary, and skimming is the failure this whole product
 * exists to make harder.
 */
export function renderPanelComplete(
  members: readonly RunRecord[],
  panelId: string,
): string[] {
  if (members.length < 2) return [];

  const contributed = members.filter((m) => m.state === 'completed' && m.reportChars > 0 && m.sourceCount > 0);
  const ids = contributed.map((m) => m.id);

  return [
    '',
    '---',
    '',
    `## Panel \`${panelId}\` is complete: ${String(contributed.length)} of ${String(members.length)} members produced evidence`,
    '',
    ...members.map((m) => {
      if (m.state === 'completed' && m.reportChars > 0) {
        const derivative = m.spawnedBy ? ' — **NOT INDEPENDENT**, started by a CLI Dossier spawned' : '';
        const unsourced = m.sourceCount === 0 ? ' — **CITES NOTHING**, so it is not evidence' : '';
        return `- ${m.sourceCount === 0 ? '⚠' : '✅'} \`${m.id}\` ${m.provider}: ${String(m.reportChars)} chars, ${String(m.sourceCount)} cited sources${unsourced}${derivative}`;
      }
      if (m.state === 'completed') return `- ⚠ \`${m.id}\` ${m.provider}: completed but produced no report text`;
      return `- ❌ \`${m.id}\` ${m.provider}: ${m.state}`;
    }),
    '',
    '### What to do now, in this order',
    '',
    ids.length >= 2
      ? `1. **Merge them.** \`research_synthesise { runIds: [${ids.map((i) => `"${i}"`).join(', ')}] }\`. Free, no research call. It deduplicates sources by canonical URL, counts support in INDEPENDENT registrable domains rather than in backends, and says where the members disagree.`
      : `1. **There is nothing to merge.** Only ${String(ids.length)} member produced evidence, so treat this as a single-backend answer and say so; a panel that lost its members is not corroboration.`,
    `2. **Read the report in detail, not in outline.** \`research_read { runId, mode: "section" }\` section by section on each member that contributed. An outline gives you headings, and a finding's caveats, its sample size and the sentence that qualifies it all live in the body. Reporting from an outline is how a hedged result becomes a confident one.`,
    `3. **Open the member reports the merge points at.** The merge names which backend produced which claim precisely so you can go and read it where it matters. Where two members disagree, read BOTH before deciding, and where one is the sole source of a claim you intend to rely on, read that one.`,
    `4. **Check the citations resolve.** \`research_verify_citations { runId }\` per member. It reports a fabrication check separately from reachability; the fabrication number is the one that decides whether a report can be trusted.`,
    '',
    '> [!NOTE]',
    '> Present this to the user as one result. Every member is finished, so there is no longer a reason to report them separately, and separate reporting is what makes several backends reading the same page look like several independent findings.',
  ];
}

/**
 * The in-flight picture a monitor reports, grouped by panel.
 *
 * Grouped because a monitor polling every two minutes is reporting to a person,
 * and "5 runs in flight" is not what they asked; they asked how long. A panel is
 * one thing that finishes at one time, so it gets one line and one estimate.
 *
 * The estimate is always TIME REMAINING, never total duration. A caller who is
 * three minutes into a run does not need to be told the run takes four to twenty
 * minutes; they need to know how much is left, and the difference is the whole
 * reason to check again in two minutes rather than once at the start.
 */
export function renderInFlight(active: readonly RunRecord[], now: number = Date.now()): string[] {
  const panels = new Map<string, RunRecord[]>();
  const solo: RunRecord[] = [];
  for (const r of active) {
    if (r.panelId) {
      const list = panels.get(r.panelId) ?? [];
      list.push(r);
      panels.set(r.panelId, list);
    } else solo.push(r);
  }

  const lines: string[] = [];
  for (const [panelId, members] of panels) {
    const p = panelProgress(members, now);
    lines.push(
      `- **Panel \`${panelId}\`**: ${String(p.settled)} of ${String(p.total)} in-flight members settled. ` +
        `**Time remaining: ${describeRemaining(p)}.**`,
      ...members.map((m) => `  - \`${m.id}\` ${m.provider}, ${m.state}`),
    );
  }
  for (const r of solo) {
    const band = estimateDuration({ tier: r.tier });
    const elapsed = Math.max(0, (now - Date.parse(r.createdAt)) / 60_000);
    const remHigh = Math.max(0, Math.round(band.highMinutes - elapsed));
    const remLow = Math.max(0, Math.round(band.lowMinutes - elapsed));
    const rem =
      remHigh === 0
        ? 'past its expected band; still working unless marked `stalled`'
        : remLow === 0
          ? `up to about ${String(remHigh)} more minute(s)`
          : `roughly ${String(remLow)}-${String(remHigh)} more minute(s)`;
    lines.push(`- \`${r.id}\` ${r.provider}, ${r.state}. **Time remaining: ${rem}.**`);
  }
  return lines;
}
