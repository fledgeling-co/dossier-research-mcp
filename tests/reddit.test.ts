import { describe, expect, it } from 'vitest';
import {
  relevantTo,
  discoveryQuery,
  discoveryTerms,
  gatherSubreddit,
  inferWindow,
  subredditsFromUrls,
  windowStartEpoch,
  type RedditItem,
} from '../src/research/reddit.js';

describe('inferWindow', () => {
  it('reads the period out of the question', () => {
    expect(inferWindow('what happened today?').window).toBe('24h');
    expect(inferWindow('what shipped this week?').window).toBe('7d');
    expect(inferWindow('how are people finding it lately?').window).toBe('30d');
    expect(inferWindow('what changed last quarter?').window).toBe('90d');
    expect(inferWindow('what did people say in 2026?').window).toBe('1y');
    expect(inferWindow('best of all time?').window).toBe('all');
  });

  it('tries the narrow rules first', () => {
    // "in the last day" must not be swallowed by a "last ... year" pattern, so
    // the rule order is load-bearing rather than incidental.
    expect(inferWindow('what broke in the last 24 hours?').window).toBe('24h');
    expect(inferWindow('what shipped in the past week?').window).toBe('7d');
  });

  it('defaults to a month, not the server-wide year, and says why', () => {
    // A year of a busy subreddit is mostly old items, and a thread nobody has
    // replied to in six months is not what "what do people think" is asking.
    const v = inferWindow('is pgvector any good?');
    expect(v.window).toBe('30d');
    expect(v.inferred).toBe(true);
    expect(v.why).toMatch(/decays/);
  });

  it('lets the caller override, and says the choice was theirs', () => {
    const v = inferWindow('what happened today?', '5y');
    expect(v.window).toBe('5y');
    expect(v.inferred).toBe(false);
  });

  it('gives `all` no lower bound', () => {
    expect(windowStartEpoch('all')).toBeUndefined();
    expect(windowStartEpoch('24h')).toBeGreaterThan(0);
  });
});

describe('discoveryTerms', () => {
  it('drops the question’s grammar', () => {
    // The defect this exists for. Taking every word of four letters or more
    // offered r/Whatcouldgowrong, r/whatisthisthing and r/thinkpad for this
    // exact question — matches on "what", "think" and "people", ranked to the
    // top by sheer size. That is worse than nothing: it looks like an answer.
    const terms = discoveryTerms('What do people think of vector databases lately?');
    for (const junk of ['what', 'think', 'people', 'lately']) {
      expect(terms, junk).not.toContain(junk);
    }
  });

  it('prefers the compound form communities are named after', () => {
    // A subreddit is a thing without spaces. `vectordatabase` is the name;
    // `vector` alone is swamped by everything starting with those letters.
    const terms = discoveryTerms('What do people think of vector databases lately?');
    expect(terms).toContain('vectordatabase');
  });

  it('tries the singular, because communities are not pluralised', () => {
    expect(discoveryTerms('thoughts on vector databases')).toContain('vectordatabase');
    expect(discoveryTerms('which graph libraries are best')).toContain('graphlibrary');
  });

  it('is bounded, so a long question cannot fan out into a dozen requests', () => {
    const terms = discoveryTerms('what do people think about vector databases and graph databases and search engines and embedding models in production');
    expect(terms.length).toBeLessThanOrEqual(6);
  });
});

describe('subredditsFromUrls', () => {
  it('pulls names out of result URLs and de-duplicates', () => {
    expect(
      subredditsFromUrls([
        'https://www.reddit.com/r/vectordatabase/comments/abc/title/',
        'https://reddit.com/r/vectordatabase/comments/def/',
        'https://old.reddit.com/r/LocalLLaMA/comments/xyz/',
        'https://example.com/not-reddit',
      ]).sort(),
    ).toEqual(['LocalLLaMA', 'vectordatabase']);
  });
});

describe('the discovery loop', () => {
  it('extracts the community a name search could never have found', () => {
    // The whole point of the second stage. `r/LocalLLaMA` discusses vector
    // databases constantly under a name sharing no substring with the subject,
    // so no prefix search reaches it — but a subject search does, and the URL
    // it returns names the community.
    const found = subredditsFromUrls([
      'https://www.reddit.com/r/LocalLLaMA/comments/abc/best_vector_db/',
      'https://www.reddit.com/r/vectordatabase/comments/def/pgvector/',
    ]);
    expect(found).toContain('LocalLLaMA');
    expect(discoveryTerms('what do people think of vector databases')).not.toContain('localllama');
  });

  it('ignores a URL that is not Reddit', () => {
    // Search results are mixed. A vendor blog must not become a subreddit name.
    expect(subredditsFromUrls(['https://example.com/r/notreddit/x'])).toEqual([]);
    expect(subredditsFromUrls(['https://medium.com/some-post-about-r/rust'])).toEqual([]);
  });
});

describe('discoveryQuery', () => {
  it('is a site-scoped search a caller can paste anywhere', () => {
    expect(discoveryQuery('  vector   databases  ')).toBe('site:reddit.com vector databases');
  });
});

describe('gatherSubreddit', () => {
  it('drops a row whose text is not a string rather than coercing it', async () => {
    // Third-party JSON: a field can be any shape. `String(x)` on an object
    // yields "[object Object]" and stores it as a Reddit post's title, which
    // then reads downstream as a real finding.
    const rows = [
      { id: 'a', title: { nested: 'object' }, created_utc: 1, author: 'x' },
      { id: 'b', title: 'a real title', created_utc: 2, author: 'y' },
      { title: 'no id at all', created_utc: 3 },
    ];
    let call = 0;
    const fake: typeof fetch = async () => {
      call += 1;
      return new Response(JSON.stringify({ data: call === 1 ? rows : [] }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const items = await gatherSubreddit('x', 0, fake, 'https://example.invalid', 10);
    expect(items.map((i) => i.text)).toEqual(['a real title']);
  });

  it('stops when the archive returns nothing, rather than paging forever', async () => {
    let calls = 0;
    const fake: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
    };
    await gatherSubreddit('x', 0, fake, 'https://example.invalid', 400);
    // One empty page per kind is enough to stop; posts and comments are two.
    expect(calls).toBe(2);
  });
});

describe('relevantTo', () => {
  const item = (text: string, at = 1): RedditItem => ({
    kind: 'post', subreddit: 's', id: String(at), text, createdUtc: at,
  });

  it('drops the posts that made a real gather useless', () => {
    // Reported from use: a detailed question about a supplement returned 2,400
    // posts from r/Sick about food poisoning, ringworm and coughing hard enough
    // to fart. The archive filters by subreddit and time only, so everything in
    // the window came back; the question was doing nothing but pick a date.
    const q = 'Does Armaforce or zinc lozenges actually shorten a cold?';
    const { kept, dropped } = relevantTo(q, [
      item('I highly recommend taking zinc, it helps when you think you are getting sick'),
      item('I coughed so hard I farted'),
      item('is this ringworm or something else'),
      item('food poisoning from last night, how long does it last'),
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.text).toMatch(/zinc/);
    expect(dropped).toBe(3);
  });

  it('ranks a post matching more of the question above one matching less', () => {
    const { kept } = relevantTo('zinc lozenges shorten a cold', [
      item('anyone tried zinc?'),
      item('zinc lozenges did shorten my cold by a day'),
    ]);
    expect(kept[0]!.text).toMatch(/lozenges/);
  });

  it('matches a plural against a singular term and back', () => {
    expect(relevantTo('lozenges', [item('one lozenge helped')]).kept).toHaveLength(1);
    expect(relevantTo('lozenge', [item('lozenges helped')]).kept).toHaveLength(1);
  });

  it('keeps everything when the question has no salient terms', () => {
    // A question of pure stopwords must not drop the lot; that would be worse
    // than the firehose it replaced, because it looks like an empty subreddit.
    const items = [item('a'), item('b')];
    expect(relevantTo('what about this then', items).kept).toHaveLength(2);
    expect(relevantTo('', items).dropped).toBe(0);
  });

  it('does not match on the question’s grammar', () => {
    // The same defect the subreddit discovery had: "does", "actually" and
    // "about" are in the question and must not make a post relevant.
    const { kept } = relevantTo('Does Armaforce actually work about colds', [
      item('does anyone actually know what this is about'),
    ]);
    expect(kept).toHaveLength(0);
  });
});
