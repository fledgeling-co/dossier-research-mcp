import { describe, expect, it } from 'vitest';
import { cliEnv } from '../src/local/cli.js';

/**
 * What a spawned CLI inherits.
 *
 * Dossier usually runs as a stdio MCP server launched BY a coding CLI, so its
 * own environment is that CLI's session state — and those variables are not
 * inert, they configure the very program being spawned.
 */
describe('cliEnv', () => {
  const parent: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    HOME: '/Users/x',
    CLAUDE_EFFORT: 'xhigh',
    CLAUDE_CODE_SESSION_ID: 'd3101d4a',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '0',
    ANTHROPIC_API_KEY: 'sk-should-not-travel',
    GEMINI_API_KEY: 'g',
  };

  it('drops the effort setting that broke a real run', () => {
    // Observed: a run came back `completed` with a 9,140 character report
    // explaining its own web search was down with `effort 'xhigh' not supported
    // when thinking is disabled`. The operator's settings had thinking ENABLED;
    // the xhigh came from the session that launched Dossier.
    expect(cliEnv(parent).CLAUDE_EFFORT).toBeUndefined();
  });

  it('drops the parent’s session identity', () => {
    // A spawn told it is a child of a conversation it has never seen.
    const e = cliEnv(parent);
    expect(e.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(e.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
    expect(e.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING).toBeUndefined();
  });

  it('drops ANTHROPIC_API_KEY, so the $0.00 cost band is true', () => {
    // It outranks the subscription in -p mode with no prompt. Leaving it makes
    // this provider's own basis — "no API charge: the run draws on your CLI
    // subscription" — a false statement, and the band is what every budget
    // decision is made from.
    expect(cliEnv(parent).ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('keeps everything a CLI actually needs to run', () => {
    // Over-stripping would be the worse defect: a CLI that cannot find its own
    // PATH or home directory fails in a way that reads as a Dossier bug.
    const e = cliEnv(parent);
    expect(e.PATH).toBe('/usr/bin');
    expect(e.HOME).toBe('/Users/x');
    // Not Claude Code's, and another backend may need it.
    expect(e.GEMINI_API_KEY).toBe('g');
  });

  it('leaves the real process environment untouched', () => {
    // It returns a copy. Mutating `process.env` from here would change the
    // server's own configuration as a side effect of starting a subprocess.
    const before = process.env.PATH;
    cliEnv();
    expect(process.env.PATH).toBe(before);
  });
});

describe('a member that cites nothing', () => {
  it('is not counted as having contributed, however long its report', async () => {
    // Length is exactly the wrong test. Both real cases were a CLI whose web
    // search was broken writing a lucid 3,171 and 9,140 character account of
    // why it could not research — longer than many real findings.
    const { mergeContribution } = await import('../src/research/runner.js');
    const members = [
      { state: 'completed', reportChars: 9140, sourceCount: 0 },
      { state: 'completed', reportChars: 400, sourceCount: 3 },
      { state: 'failed', reportChars: 0, sourceCount: 0 },
    ];
    const split = mergeContribution(members);
    expect(split.contributed).toHaveLength(1);
    expect(split.unsourced).toHaveLength(1);
  });
});
