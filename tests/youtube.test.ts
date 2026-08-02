import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIN_SUBSCRIBERS,
  DEFAULT_MIN_VIEWS,
  gather,
  parseCount,
  parseDuration,
  parseJson3,
  parseRelativeDays,
  passesCheapFloor,
  renderGather,
  searchPage,
  subscribersFrom,
  type CaptionResponse,
  type GatherOutcome,
  type YouTubeHit,
} from '../src/research/youtube.js';

const hit = (over: Partial<YouTubeHit> = {}): YouTubeHit => ({
  videoId: 'abc12345678',
  url: 'https://www.youtube.com/watch?v=abc12345678',
  title: 'A talk',
  channel: 'Someone',
  channelId: 'UC_x',
  views: 100_000,
  publishedText: '2 months ago',
  publishedDaysAgo: 60,
  durationSeconds: 900,
  ...over,
});

describe('parseCount', () => {
  it('reads every form YouTube writes a count in', () => {
    expect(parseCount('62,742 views')).toBe(62_742);
    expect(parseCount('1.2M subscribers')).toBe(1_200_000);
    expect(parseCount('4.24 million subscribers')).toBe(4_240_000);
    expect(parseCount('172K subscribers')).toBe(172_000);
    expect(parseCount('466 thousand subscribers')).toBe(466_000);
  });

  it('returns undefined rather than a number for text carrying none', () => {
    expect(parseCount('No views')).toBeUndefined();
  });
});

describe('parseRelativeDays', () => {
  it('converts the relative strings YouTube actually returns', () => {
    expect(parseRelativeDays('3 weeks ago')).toBe(21);
    expect(parseRelativeDays('2 months ago')).toBe(60);
    expect(parseRelativeDays('1 year ago')).toBe(365);
    expect(parseRelativeDays('4 hours ago')).toBe(0);
  });

  it('treats an unreadable string as infinitely old, so a recency filter excludes it', () => {
    expect(parseRelativeDays('Streamed live')).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('parseDuration', () => {
  it('reads hours, which is where a minutes-only reader turns 2h34m into 154:01', () => {
    expect(parseDuration('19:15')).toBe(1_155);
    expect(parseDuration('2:34:01')).toBe(9_241);
    expect(parseDuration('')).toBe(0);
  });
});

describe('passesCheapFloor', () => {
  it('applies the default view floor when none is given', () => {
    expect(passesCheapFloor(hit({ views: DEFAULT_MIN_VIEWS - 1 }), {})).toBe(false);
    expect(passesCheapFloor(hit({ views: DEFAULT_MIN_VIEWS }), {})).toBe(true);
  });

  it('excludes a video older than the window and shorter than the length floor', () => {
    expect(passesCheapFloor(hit({ publishedDaysAgo: 60 }), { publishedWithinDays: 30 })).toBe(false);
    expect(passesCheapFloor(hit({ durationSeconds: 45 }), { minDurationSeconds: 60 })).toBe(false);
  });
});

describe('subscribersFrom', () => {
  // The defect this exists for: the response carries several
  // `subscriberCountText` values and none of them is the channel's own.
  const channel = {
    header: {
      pageHeaderRenderer: {
        content: {
          pageHeaderViewModel: {
            metadata: {
              contentMetadataViewModel: {
                metadataRows: [
                  { metadataParts: [{ text: { content: '@somechannel' } }] },
                  {
                    metadataParts: [
                      { text: { content: '4.24M subscribers' } },
                      { text: { content: '1.2K videos' } },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    },
    // The sidebar. Reading these gives 466,000, which is wrong and plausible.
    contents: { items: [{ subscriberCountText: { simpleText: '466K subscribers' } }] },
  };

  it('reads the channel header rather than the recommended-channel sidebar', () => {
    expect(subscribersFrom(channel)).toBe(4_240_000);
  });

  it('finds the row by the word rather than by position', () => {
    const reordered = structuredClone(channel);
    const rows =
      reordered.header.pageHeaderRenderer.content.pageHeaderViewModel.metadata.contentMetadataViewModel.metadataRows;
    rows.reverse();
    expect(subscribersFrom(reordered)).toBe(4_240_000);
  });

  it('returns undefined for a shape it does not recognise', () => {
    expect(subscribersFrom({ nothing: true })).toBeUndefined();
  });
});

describe('parseJson3', () => {
  it('joins segments into lines with a start time', () => {
    const body = JSON.stringify({
      events: [
        { tStartMs: 0, segs: [{ utf8: 'All ' }, { utf8: 'right,' }] },
        { tStartMs: 2_500, segs: [{ utf8: 'so here we are' }] },
        { tStartMs: 4_000, segs: [{ utf8: '  ' }] },
      ],
    });
    expect(parseJson3(body)).toEqual([
      { start: 0, text: 'All right,' },
      { start: 2.5, text: 'so here we are' },
    ]);
  });

  it('returns nothing for the empty body a blocked caption URL serves', () => {
    expect(parseJson3('')).toEqual([]);
  });
});

/**
 * A fetch that answers from a table, so nothing here touches a network.
 *
 * Captions come back through a separate `caption` function rather than through
 * `fn`, because the real caption fetch goes through `safeFetch` and the
 * InnerTube calls do not. Two seams in the test because there are two in the
 * code, and the reason is which side chose the URL.
 */
function scriptedFetch(table: {
  search?: unknown;
  /** Keyed by continuation token; `search` is page one. */
  pages?: Record<string, unknown>;
  channels?: Record<string, unknown>;
  player?: Record<string, unknown>;
  captions?: Record<string, string>;
}): {
  fn: typeof fetch;
  caption: (url: string, timeoutMs: number) => Promise<CaptionResponse>;
  calls: string[];
} {
  const calls: string[] = [];
  const json = (v: unknown): Response =>
    new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });

  const fn = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
    const sent = typeof init?.body === 'string' ? init.body : '{}';
    calls.push(url);
    if (url.includes('/youtubei/v1/search')) {
      const body = JSON.parse(sent) as { continuation?: string };
      if (body.continuation !== undefined) return json(table.pages?.[body.continuation] ?? {});
      return json(table.search ?? {});
    }
    if (url.includes('/youtubei/v1/browse')) {
      const body = JSON.parse(sent) as { browseId?: string };
      return json(table.channels?.[body.browseId ?? ''] ?? {});
    }
    if (url.includes('/youtubei/v1/player')) {
      const body = JSON.parse(sent) as { videoId?: string };
      return json(table.player?.[body.videoId ?? ''] ?? {});
    }
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;

  const caption = (url: string): Promise<CaptionResponse> => {
    calls.push(url);
    const found = Object.entries(table.captions ?? {}).find(([k]) => url.includes(k));
    return Promise.resolve({ ok: true, status: 200, body: found?.[1] ?? '' });
  };

  return { fn, caption, calls };
}

const searchResponse = (
  videos: readonly { id: string; views: string; channel: string; channelId: string; when: string }[],
): unknown => ({
  contents: {
    twoColumnSearchResultsRenderer: {
      primaryContents: {
        sectionListRenderer: {
          contents: videos.map((v) => ({
            itemSectionRenderer: {
              contents: [
                {
                  videoRenderer: {
                    videoId: v.id,
                    title: { runs: [{ text: `Talk ${v.id}` }] },
                    viewCountText: { simpleText: v.views },
                    publishedTimeText: { simpleText: v.when },
                    lengthText: { simpleText: '19:15' },
                    ownerText: {
                      runs: [
                        {
                          text: v.channel,
                          navigationEndpoint: { browseEndpoint: { browseId: v.channelId } },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          })),
        },
      },
    },
  },
});

const channelWith = (count: string): unknown => ({
  header: {
    pageHeaderRenderer: {
      content: {
        pageHeaderViewModel: {
          metadata: {
            contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: count } }] }] },
          },
        },
      },
    },
  },
});

const playerWith = (baseUrl: string, kind?: string): unknown => ({
  playabilityStatus: { status: 'OK' },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [{ baseUrl, languageCode: 'en', ...(kind === undefined ? {} : { kind }) }],
    },
  },
});

describe('searchPage', () => {
  it('reads view count, channel and publish time out of the WEB response', async () => {
    const { fn } = scriptedFetch({
      search: searchResponse([
        { id: 'aaa', views: '62,742 views', channel: 'Rusty', channelId: 'UC_a', when: '2 months ago' },
      ]),
    });
    const { hits } = await searchPage('rust async', { fetchImpl: fn });
    const [got] = hits;
    expect(got).toMatchObject({
      videoId: 'aaa',
      views: 62_742,
      channel: 'Rusty',
      channelId: 'UC_a',
      publishedDaysAgo: 60,
      durationSeconds: 1_155,
    });
  });
});

describe('gather', () => {
  const twoVideos = searchResponse([
    { id: 'big', views: '500,000 views', channel: 'Big', channelId: 'UC_big', when: '1 month ago' },
    { id: 'small', views: '900 views', channel: 'Small', channelId: 'UC_small', when: '1 month ago' },
  ]);

  it('drops what falls below the floor and never looks up its channel', async () => {
    const { fn, caption, calls } = scriptedFetch({
      search: twoVideos,
      channels: { UC_big: channelWith('172K subscribers') },
      player: { big: playerWith('https://caption/big') },
      captions: { 'caption/big': JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: 'hello' }] }] }) },
    });

    const out = await gather('rust async', {}, { fetchImpl: fn, fetchCaption: caption });

    expect(out.videos.map((v) => v.videoId)).toEqual(['big']);
    expect(out.belowFloor).toBe(1);
    expect(out.scanned).toBe(2);
    // The cost claim: the sub-30k video costs no browse request.
    expect(out.channelLookups).toBe(1);
    expect(calls.some((c) => c.includes('browse') )).toBe(true);
  });

  it('excludes a video whose channel is below the subscriber floor', async () => {
    const { fn, caption } = scriptedFetch({
      search: twoVideos,
      channels: { UC_big: channelWith('4K subscribers') },
    });
    const out = await gather('rust async', {}, { fetchImpl: fn, fetchCaption: caption });
    expect(out.videos).toEqual([]);
    expect(out.belowFloor).toBe(2);
  });

  it('looks a channel up once however many of its videos survive', async () => {
    const { fn, caption, calls } = scriptedFetch({
      search: searchResponse([
        { id: 'one', views: '500,000 views', channel: 'Big', channelId: 'UC_big', when: '1 month ago' },
        { id: 'two', views: '400,000 views', channel: 'Big', channelId: 'UC_big', when: '1 month ago' },
      ]),
      channels: { UC_big: channelWith('172K subscribers') },
      player: { one: playerWith('https://caption/one'), two: playerWith('https://caption/two') },
      captions: {
        'caption/one': JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: 'one' }] }] }),
        'caption/two': JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: 'two' }] }] }),
      },
    });
    const out = await gather('rust async', {}, { fetchImpl: fn, fetchCaption: caption });
    expect(out.videos).toHaveLength(2);
    expect(out.channelLookups).toBe(1);
    expect(calls.filter((c) => c.includes('browse'))).toHaveLength(1);
  });

  it('reports a video with no captions as unreadable rather than dropping it', async () => {
    const { fn, caption } = scriptedFetch({
      search: searchResponse([
        { id: 'big', views: '500,000 views', channel: 'Big', channelId: 'UC_big', when: '1 month ago' },
      ]),
      channels: { UC_big: channelWith('172K subscribers') },
      player: { big: { playabilityStatus: { status: 'OK' } } },
    });
    const out = await gather('rust async', {}, { fetchImpl: fn, fetchCaption: caption });
    expect(out.videos[0]?.transcript).toBeUndefined();
    expect(out.videos[0]?.unreadable).toContain('no caption track');
  });

  it('names the empty-body block rather than reporting it as no captions', async () => {
    const { fn, caption } = scriptedFetch({
      search: searchResponse([
        { id: 'big', views: '500,000 views', channel: 'Big', channelId: 'UC_big', when: '1 month ago' },
      ]),
      channels: { UC_big: channelWith('172K subscribers') },
      player: { big: playerWith('https://caption/big') },
      captions: { 'caption/big': '' },
    });
    const out = await gather('rust async', {}, { fetchImpl: fn, fetchCaption: caption });
    expect(out.videos[0]?.unreadable).toContain('empty');
  });

  it('honours an explicitly lowered floor', async () => {
    const { fn, caption } = scriptedFetch({
      search: twoVideos,
      channels: { UC_big: channelWith('172K subscribers'), UC_small: channelWith('100 subscribers') },
      player: { big: playerWith('https://c/big'), small: playerWith('https://c/small') },
      captions: {
        'c/big': JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: 'a' }] }] }),
        'c/small': JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: 'b' }] }] }),
      },
    });
    const out = await gather(
      'rust async',
      { minViews: 100, minSubscribers: 50 },
      { fetchImpl: fn, fetchCaption: caption },
    );
    expect(out.videos).toHaveLength(2);
  });

  /** A page-one response that hands back a continuation token. */
  const withContinuation = (body: Record<string, unknown>, token: string): unknown => ({
    ...body,
    continuations: [{ continuationCommand: { token } }],
  });

  it('follows the continuation when page one does not fill the limit', async () => {
    const { fn, caption } = scriptedFetch({
      search: withContinuation(
        searchResponse([
          { id: 'p1', views: '500,000 views', channel: 'Big', channelId: 'UC_big', when: '1 month ago' },
        ]) as Record<string, unknown>,
        'TOKEN_2',
      ),
      pages: {
        TOKEN_2: searchResponse([
          { id: 'p2', views: '400,000 views', channel: 'Two', channelId: 'UC_two', when: '1 month ago' },
        ]),
      },
      channels: { UC_big: channelWith('172K subscribers'), UC_two: channelWith('99K subscribers') },
      player: { p1: playerWith('https://c/p1'), p2: playerWith('https://c/p2') },
      captions: {
        'c/p1': JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: 'one' }] }] }),
        'c/p2': JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: 'two' }] }] }),
      },
    });
    const out = await gather('rust async', {}, { limit: 2, fetchImpl: fn, fetchCaption: caption });
    expect(out.videos.map((v) => v.videoId)).toEqual(['p1', 'p2']);
    expect(out.pages).toBe(2);
    expect(out.hitPageLimit).toBe(false);
  });

  it('stops at maxPages and says the ceiling is what stopped it', async () => {
    // Every page returns the same below-floor video and another token, which is
    // the shape that walks forever without a ceiling.
    const page = withContinuation(
      searchResponse([
        { id: 'tiny', views: '90 views', channel: 'Tiny', channelId: 'UC_tiny', when: '1 month ago' },
      ]) as Record<string, unknown>,
      'SAME',
    );
    const { fn, caption } = scriptedFetch({ search: page, pages: { SAME: page } });
    const out = await gather('rust async', {}, { limit: 3, maxPages: 2, fetchImpl: fn, fetchCaption: caption });
    expect(out.pages).toBe(2);
    expect(out.hitPageLimit).toBe(true);
    // The repeat is not counted twice: one video was seen, whatever the pages.
    expect(out.scanned).toBe(1);
    expect(out.belowFloor).toBe(1);
  });

  it('reports an exhausted search as exhausted rather than as a ceiling', async () => {
    const { fn, caption } = scriptedFetch({
      search: searchResponse([
        { id: 'tiny', views: '90 views', channel: 'Tiny', channelId: 'UC_tiny', when: '1 month ago' },
      ]),
    });
    const out = await gather('rust async', {}, { limit: 3, fetchImpl: fn, fetchCaption: caption });
    expect(out.hitPageLimit).toBe(false);
    expect(out.pages).toBe(1);
  });
});

describe('renderGather', () => {
  const outcome = (over: Partial<GatherOutcome> = {}): GatherOutcome => ({
    videos: [],
    scanned: 19,
    belowFloor: 18,
    channelLookups: 1,
    pages: 1,
    hitPageLimit: false,
    minViews: DEFAULT_MIN_VIEWS,
    minSubscribers: DEFAULT_MIN_SUBSCRIBERS,
    ...over,
  });

  it('states what was excluded, so an empty answer is legible', () => {
    const text = renderGather('rust async', outcome()).join('\n');
    expect(text).toContain('18 fell below the floor');
    expect(text).toContain('Nothing cleared the floor');
  });

  it('warns that a view count is not a check on correctness', () => {
    expect(renderGather('x', outcome()).join('\n')).toContain('weak one');
  });

  it('states when the page ceiling stopped the search rather than the topic', () => {
    const text = renderGather('x', outcome({ hitPageLimit: true, pages: 4 })).join('\n');
    expect(text).toContain('4-page ceiling');
  });

  it('marks a truncated transcript rather than silently clipping it', () => {
    const text = renderGather(
      'x',
      outcome({
        videos: [
          {
            ...hit(),
            subscribers: 172_000,
            transcript: {
              languageCode: 'en',
              generated: true,
              segments: [{ start: 0, text: 'word '.repeat(400) }],
            },
          },
        ],
      }),
      100,
    ).join('\n');
    expect(text).toContain('transcript truncated at 100 characters');
    expect(text).toContain('Auto-generated');
  });
});
