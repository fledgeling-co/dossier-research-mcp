import { describe, expect, it } from 'vitest';
import {
  describeRemaining,
  panelProgress,
  renderInFlight,
  renderPanelComplete,
  renderPanelWaiting,
} from '../src/research/panel-view.js';
import type { RunRecord } from '../src/store/types.js';

const T0 = Date.parse('2026-07-29T10:00:00.000Z');

function member(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'dr_x',
    provider: 'gemini',
    state: 'running',
    tier: 'fast',
    archetype: 'technical',
    question: 'q',
    prompt: 'p',
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    lastProgressAt: new Date(T0).toISOString(),
    estimatedCostUsd: 2,
    reportChars: 0,
    sourceCount: 0,
    reasoningSteps: 0,
    streamedChars: 0,
    searches: 0,
    corpusQueries: 0,
    ...over,
  } as RunRecord;
}

describe('panel progress', () => {
  it('reports time REMAINING, shrinking as the run ages', () => {
    const m = [member({ id: 'a', panelId: 'p' }), member({ id: 'b', panelId: 'p' })];
    const fresh = panelProgress(m, T0);
    // The fast band is 4-20 minutes, so at t=0 remaining is the whole band.
    expect(fresh.remainingHighMinutes).toBe(20);

    const later = panelProgress(m, T0 + 15 * 60_000);
    // Fifteen minutes in, five are left. This is the number a monitor reports,
    // and reporting the total band instead would repeat "4-20" every two minutes.
    expect(later.remainingHighMinutes).toBe(5);
    expect(later.remainingLowMinutes).toBe(0);
  });

  it('takes the slowest member, never an average', () => {
    // A panel is finished when its slowest member is, so an average would
    // promise a time the caller then watches pass.
    const m = [
      member({ id: 'a', panelId: 'p', tier: 'fast' }),
      member({ id: 'b', panelId: 'p', tier: 'max' }),
    ];
    expect(panelProgress(m, T0).remainingHighMinutes).toBe(60);
  });

  it('says the band has passed without calling it a failure', () => {
    const m = [member({ id: 'a', panelId: 'p' }), member({ id: 'b', panelId: 'p' })];
    const p = panelProgress(m, T0 + 90 * 60_000);
    expect(p.overdue).toBe(true);
    expect(describeRemaining(p)).toContain('not yet a failure');
  });

  it('excludes settled members from the estimate', () => {
    const m = [
      member({ id: 'a', panelId: 'p', state: 'completed' }),
      member({ id: 'b', panelId: 'p', state: 'running' }),
    ];
    const p = panelProgress(m, T0);
    expect(p.settled).toBe(1);
    expect(p.allTerminal).toBe(false);
  });
});

describe('what a caller is told', () => {
  it('withholds the invitation to read while siblings run, and says why', () => {
    const m = [
      member({ id: 'a', panelId: 'p', state: 'completed', reportChars: 900, sourceCount: 7 }),
      member({ id: 'b', panelId: 'p', state: 'running' }),
    ];
    const out = renderPanelWaiting(m, 'p', T0).join('\n');
    expect(out).toMatch(/not finished/);
    expect(out).toMatch(/nothing to report to the user yet beyond progress/);
    // The specific instruction, because an agent told "completed" will read it.
    expect(out).toMatch(/Do NOT report findings from a member/);
    expect(out).toMatch(/monitor/i);
  });

  it('says nothing at all once every member has settled', () => {
    const m = [
      member({ id: 'a', panelId: 'p', state: 'completed' }),
      member({ id: 'b', panelId: 'p', state: 'failed' }),
    ];
    expect(renderPanelWaiting(m, 'p', T0)).toEqual([]);
  });

  it('is silent for a run that is not in a panel', () => {
    expect(renderPanelWaiting([member()], 'p', T0)).toEqual([]);
    expect(renderPanelComplete([member()], 'p')).toEqual([]);
  });

  it('hands back every member at once, with the merge and the reading order', () => {
    const m = [
      member({ id: 'a', panelId: 'p', state: 'completed', reportChars: 900, sourceCount: 7 }),
      member({ id: 'b', panelId: 'p', state: 'completed', reportChars: 800, sourceCount: 4 }),
      member({ id: 'c', panelId: 'p', state: 'failed' }),
    ];
    const out = renderPanelComplete(m, 'p').join('\n');
    expect(out).toMatch(/2 of 3 members produced evidence/);
    expect(out).toMatch(/research_synthesise \{ runIds: \["a", "b"\] \}/);
    // Read in detail, not in outline: the user's actual instruction.
    expect(out).toMatch(/in detail, not in outline/);
    expect(out).toMatch(/Open the member reports the merge points at/);
    expect(out).toMatch(/Present this to the user as one result/);
  });

  it('refuses to call one surviving member a panel', () => {
    const m = [
      member({ id: 'a', panelId: 'p', state: 'completed', reportChars: 900, sourceCount: 7 }),
      member({ id: 'b', panelId: 'p', state: 'failed' }),
    ];
    const out = renderPanelComplete(m, 'p').join('\n');
    expect(out).toMatch(/nothing to merge/);
    expect(out).toMatch(/not corroboration/);
  });

  it('groups the in-flight view by panel, one estimate per panel', () => {
    const m = [
      member({ id: 'a', panelId: 'p1' }),
      member({ id: 'b', panelId: 'p1' }),
      member({ id: 'solo' }),
    ];
    const out = renderInFlight(m, T0 + 15 * 60_000).join('\n');
    expect(out).toMatch(/Panel `p1`/);
    expect(out).toMatch(/Time remaining/);
    // One line for the panel, not one per member competing for attention.
    expect(out.match(/Time remaining/g)).toHaveLength(2);
  });
});
