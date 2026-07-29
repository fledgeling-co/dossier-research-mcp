/**
 * What actually works for a site a search index cannot reach.
 *
 * The crawl recommendation used to say "use browser tooling" for every site
 * alike. That is true and nearly useless: the tactic that reaches LinkedIn is
 * not the tactic that reaches Instagram, and for one of them the right answer
 * is not to crawl at all.
 *
 * **Where these came from, and how far to trust each.** Two sources, kept
 * apart on purpose.
 *
 * Facts marked `verified` were established here, against the live site, on
 * 29 July 2026. Facts marked `vendor` come from Scrape Creators' public
 * changelog — a commercial scraping API describing its own breakages. That is
 * good evidence about what is hard, because a vendor documenting nine months of
 * outage on an endpoint it sells is testifying against interest. It is weak
 * evidence about what is impossible, because their business is the workaround.
 * Neither is treated as the other.
 *
 * **Why this exists rather than a set of extractors.** The same changelog is
 * the argument: 97 updates in fourteen months, a large share of them
 * breakage-driven. TikTok stripped profile regions and it took nine months to
 * restore. Google broke ad-copy retrieval and the fallback was OCR, shipped
 * with the caveat that it "might be a little inaccurate". Reddit, in their
 * words, "nuked the source data on us". Owning extractors means owning that
 * treadmill, and a research tool that is silently three months stale on a
 * platform is worse than one that says plainly what it cannot reach.
 */

/** How confident the tactic is, and who established it. */
export type TacticProvenance = 'verified' | 'vendor';

export interface SiteTactic {
  /** Registrable domain this applies to. */
  readonly domain: string;
  readonly label: string;
  /** What to actually do, in order of preference. */
  readonly tactics: readonly {
    readonly how: string;
    readonly provenance: TacticProvenance;
  }[];
  /** What will NOT work, so nobody spends an afternoon finding out. */
  readonly deadEnds: readonly {
    readonly what: string;
    readonly provenance: TacticProvenance;
  }[];
}

export const SITE_TACTICS: readonly SiteTactic[] = [
  {
    domain: 'reddit.com',
    label: 'Reddit',
    tactics: [
      {
        // Corrected twice in one day, and this is why the tactic exists at all.
        //
        // First reading: register a script app. Walked it — `create app` returns
        // a policy link and creates nothing. Second reading: therefore no route
        // exists. Wrong again, and the counter-example was a production pipeline
        // on the same machine. Arctic Shift is a public Reddit archive with an
        // open API, and it is what Reddit research actually runs on now that
        // Pushshift is gone.
        //
        // Verified here on 29 July 2026: `/api/posts/search` and
        // `/api/comments/search` both answered 200 with posts and comments
        // timestamped the same day, on a plain unauthenticated GET, with no
        // rate limit reached across the probes.
        how:
          'Arctic Shift, a public Reddit archive: ' +
          '`https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=<sub>&after=<epoch>&before=<epoch>&limit=100&sort=desc` ' +
          'and the same path for `/api/comments/search`. No credential, posts and comments, current to today. ' +
          'It is a THIRD PARTY, not Reddit, so a query goes to whoever runs it — the same disclosure that applies ' +
          'to any backend here. `q=` alone is rejected; it filters by subreddit and time window.',
        provenance: 'verified',
      },
      {
        how:
          'Search the index: `site:reddit.com/r/<sub>` through any panel backend. No credential, no third party ' +
          'beyond the one already answering the question, and it reaches the same public threads.',
        provenance: 'verified',
      },
      {
        // Works, and the ceiling is low enough to matter. Three probes from a
        // laptop was enough to earn a 429 on the plain subreddit feed.
        how:
          'Reddit\u2019s own RSS, `reddit.com/r/<sub>/.rss`, which is keyless and still served where `.json` is ' +
          'not. Rate-limited hard: three requests from a laptop drew a 429, and datacenter addresses fare worse. ' +
          'Fine for watching one subreddit, not for gathering a corpus.',
        provenance: 'verified',
      },
      {
        how:
          'Your own established browser profile, already signed in — not an automated one, which is refused ' +
          'outright. Use a driver that ATTACHES to the browser you already use, such as chrome-devtools-mcp ' +
          'with --autoConnect.',
        provenance: 'verified',
      },
    ],
    deadEnds: [
      {
        what:
          'Registering an app at reddit.com/prefs/apps. Self-serve creation ended around November 2025: ' +
          '`create app` returns a link to the Responsible Builder Policy and creates nothing. Approval is routed ' +
          'to moderation use cases, and the request form directs developers to Devvit — which builds apps hosted ' +
          'on Reddit, not tools that read it. Credentials issued before the change still work. You do not need ' +
          'them: the archive above is open.',
        provenance: 'verified',
      },
      {
        what:
          'The `.json` endpoints. `reddit.com/r/…/search.json` answers 403 to a non-browser user-agent and ' +
          '`oauth.reddit.com` answers 403 without a token.',
        provenance: 'verified',
      },
      {
        what:
          'Driving a fresh automated browser at it. Playwright Chromium with a clean profile is served ' +
          '"You\u2019ve been blocked by network security", with no login attempted — the block is on the browser, ' +
          'not the account. Reddit\u2019s own help centre is behind the same wall.',
        provenance: 'verified',
      },
      {
        what: 'Reddit ad-library data through a commercial scraper: Scrape Creators deprecated theirs in May 2026, reporting the source data was withdrawn.',
        provenance: 'vendor',
      },
    ],
  },
  {
    domain: 'linkedin.com',
    label: 'LinkedIn',
    tactics: [
      {
        // The strongest finding in the whole exercise, and it argues against
        // building anything: a commercial LinkedIn scraper's own post search is
        // "best-effort via Google-indexed pages". If that is the state of the
        // art behind a paywall, the same route is available to any backend on
        // the panel for nothing.
        how:
          'Search the index, not the site: a `site:linkedin.com/posts` or `site:linkedin.com/in` query through ' +
          'any panel backend. This is not a poor substitute for scraping — a commercial LinkedIn API describes ' +
          'its own post search as best-effort over Google-indexed pages, which is the same route.',
        provenance: 'vendor',
      },
      {
        how: 'For a specific profile or post you can already see, a logged-in browser session reads the page you are entitled to read.',
        provenance: 'verified',
      },
    ],
    deadEnds: [
      {
        what:
          'Expecting complete profile data. Job titles and work history are withheld from unauthenticated views, ' +
          'and pagination is capped around seven pages, so "all posts by X" is not reachable by any route.',
        provenance: 'vendor',
      },
    ],
  },
  {
    domain: 'instagram.com',
    label: 'Instagram',
    tactics: [
      {
        how:
          'A logged-in browser session, driven by you. This is the case where driving your own browser beats a ' +
          'commercial scraper rather than merely matching it: the scraper rents an anonymous session behind a ' +
          'proxy pool, where you are reading pages your own account is entitled to see.',
        provenance: 'verified',
      },
      {
        how: 'For a single public post, the oEmbed/embed HTML route returns caption and author without a session.',
        provenance: 'vendor',
      },
    ],
    deadEnds: [
      {
        what:
          'Unauthenticated profile or hashtag browsing at any volume. It is rate-limited hard and the response ' +
          'shape changes without notice; a commercial vendor shipped v2 replacements for its own search and ' +
          'comments endpoints within months of shipping v1.',
        provenance: 'vendor',
      },
    ],
  },
  {
    domain: 'x.com',
    label: 'X / Twitter',
    tactics: [
      {
        // Recorded here because the panel already has the answer and a reader
        // reaching for a browser would be solving a solved problem worse.
        how:
          'Use the `xai` backend. It is the only route on this machine with live X search — first-party, and ' +
          'measured: asked for a post from the last three hours, both the Grok and Cursor CLIs answered CANNOT, ' +
          'because X search is a tool xAI attaches to its API rather than a property the weights carry.',
        provenance: 'verified',
      },
    ],
    deadEnds: [
      {
        what: 'A CLI whose model is Grok. Same weights, no X access. Recency is the discriminating test and it fails it.',
        provenance: 'verified',
      },
    ],
  },
];

/** The tactic for a site, if one is recorded. Matches on registrable domain. */
export function tacticFor(site: string): SiteTactic | null {
  const host = site
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];
  if (host === undefined || host === '') return null;
  return (
    SITE_TACTICS.find((t) => host === t.domain || host.endsWith(`.${t.domain}`)) ?? null
  );
}

/**
 * Render the tactics for the sites a question named.
 *
 * Provenance is printed per line rather than summarised, because "we checked
 * this" and "a vendor selling the workaround said this" are different claims
 * and a reader deciding where to spend an afternoon needs to tell them apart.
 */
export function renderTactics(sites: readonly string[]): string {
  const seen = new Set<string>();
  const found: SiteTactic[] = [];
  for (const site of sites) {
    const t = tacticFor(site);
    if (t && !seen.has(t.domain)) {
      seen.add(t.domain);
      found.push(t);
    }
  }
  if (found.length === 0) return '';

  const mark = (p: TacticProvenance): string =>
    p === 'verified' ? '' : ' _(reported by a commercial scraper, not verified here)_';

  const lines: string[] = ['', '**Reaching the sites this question names:**'];
  for (const t of found) {
    lines.push('', `- **${t.label}**`);
    for (const tactic of t.tactics) lines.push(`  - ${tactic.how}${mark(tactic.provenance)}`);
    for (const dead of t.deadEnds) lines.push(`  - ✗ ${dead.what}${mark(dead.provenance)}`);
  }
  return lines.join('\n');
}
