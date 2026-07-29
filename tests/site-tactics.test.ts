import { describe, expect, it } from 'vitest';
import { SITE_TACTICS, renderTactics, tacticFor } from '../src/research/site-tactics.js';

/**
 * Per-site crawl tactics.
 *
 * The value here is entirely in being specific and being honest about where
 * each claim came from, so both are asserted rather than the shape of the
 * output.
 */
describe('tacticFor', () => {
  it('matches a bare domain, a URL and a subdomain', () => {
    expect(tacticFor('reddit.com')?.domain).toBe('reddit.com');
    expect(tacticFor('https://www.reddit.com/r/programming')?.domain).toBe('reddit.com');
    expect(tacticFor('old.reddit.com')?.domain).toBe('reddit.com');
  });

  it('does not match a domain that merely ends in the same letters', () => {
    // `notreddit.com` must not inherit Reddit's tactics. The suffix check has
    // to require a dot, or every lookup is a substring match wearing a hat.
    expect(tacticFor('notreddit.com')).toBeNull();
    expect(tacticFor('example.com')).toBeNull();
  });
});

describe('the recorded tactics', () => {
  it('tells you Reddit’s .json endpoint is a dead end, from a check rather than a doc', () => {
    // Established here on 29 July 2026: 403 to a non-browser user-agent, and
    // 403 from oauth.reddit.com without a token. Plenty of advice still says
    // otherwise, which is exactly why the provenance is recorded.
    const reddit = tacticFor('reddit.com');
    const dead = reddit?.deadEnds.find((d) => d.what.includes('.json'));
    expect(dead?.provenance).toBe('verified');
  });

  it('does not send anyone to register a Reddit app, because that route is closed', () => {
    // This file shipped in 0.13.x recommending exactly that, and it was wrong.
    // Walked end to end on 29 July 2026: `create app` returns only a link to
    // the Responsible Builder Policy and creates nothing. The gate is not a
    // form to try harder at — approval is routed to moderation use cases, and
    // the request form sends developers to Devvit, which builds apps hosted ON
    // Reddit rather than tools that read it.
    const reddit = tacticFor('reddit.com');
    // prefs/apps may only appear as a dead end, never as a tactic.
    expect(reddit?.tactics.some((x) => x.how.includes('prefs/apps'))).toBe(false);
    const closed = reddit?.deadEnds.find((d) => d.what.includes('prefs/apps'));
    expect(closed?.provenance).toBe('verified');
    expect(closed?.what).toMatch(/Devvit/);
    // And a working route leads instead. Arctic Shift is a public Reddit
    // archive; verified 29 July 2026, 200 with same-day posts and comments on
    // an unauthenticated GET. Found because a production pipeline on this
    // machine was already using it while this file said no route existed.
    // The route leads with the two-stage pattern, because Arctic Shift
    // rejects `q=` and can only read a subreddit you already know — search is
    // how you learn which. Listing them as siblings hid that.
    expect(reddit?.tactics[0]?.how).toMatch(/reddit_gather/);
    const archive = reddit?.tactics.find((x) => x.how.includes('arctic-shift'));
    expect(archive).toBeDefined();
    // Named as a third party, because a query goes to whoever runs it.
    expect(archive?.how).toMatch(/THIRD PARTY/);
  });

  it('does not claim a vendor’s account as its own finding', () => {
    // The LinkedIn limits come from a commercial scraper's changelog. That is
    // strong evidence about what is hard — a vendor documenting its own
    // breakage testifies against interest — and weak evidence about what is
    // impossible, because the workaround is their business. Marking it keeps a
    // reader able to tell the two apart.
    const li = tacticFor('linkedin.com');
    expect(li?.deadEnds.every((d) => d.provenance === 'vendor')).toBe(true);
    expect(renderTactics(['linkedin.com'])).toMatch(/not verified here/);
  });

  it('routes X to the backend that actually has it, rather than to a browser', () => {
    const x = tacticFor('x.com');
    expect(x?.tactics[0]?.how).toMatch(/xai/);
    // And warns off the trap this repo measured: a Grok-backed CLI is the same
    // weights with no X access.
    expect(x?.deadEnds[0]?.what).toMatch(/Grok/);
  });

  it('renders nothing when it knows nothing, rather than padding', () => {
    expect(renderTactics(['example.com'])).toBe('');
    expect(renderTactics([])).toBe('');
  });

  it('does not repeat a site named twice', () => {
    const out = renderTactics(['reddit.com', 'https://reddit.com/r/x', 'old.reddit.com']);
    expect(out.match(/\*\*Reddit\*\*/g)).toHaveLength(1);
  });

  it('every recorded tactic states where it came from', () => {
    for (const t of SITE_TACTICS) {
      expect(t.tactics.length, t.domain).toBeGreaterThan(0);
      for (const x of [...t.tactics, ...t.deadEnds]) {
        expect(['verified', 'vendor']).toContain(x.provenance);
      }
    }
  });
});
