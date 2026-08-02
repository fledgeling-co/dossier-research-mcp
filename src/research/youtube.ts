/**
 * YouTube as a research source: search with a quality floor, then read the
 * transcript.
 *
 * **Why this is here rather than borrowed.** The same search and caption code
 * ships in `yt-transcript-gemini-mcp`. MCP servers are peers, not libraries, so
 * one cannot call another; a research run that wanted a transcript would need
 * the operator to have installed a second server and the caller to remember to
 * use it. Ported instead, deliberately, and the duplication is the price.
 *
 * **Free, and captions only.** No transcription fallback, which the standalone
 * server has. Dossier's spend model runs through the ledger and the budget gate,
 * and a per-video model call would need to go through both to be honest about
 * cost. A video with no captions is reported as unreadable rather than quietly
 * billed. That also keeps this consistent with `reddit_gather`, which is free
 * for the same reason.
 *
 * **The quality floor is the point.** A search result is not evidence. A video
 * with two hundred views from a channel with none is a stranger's opinion with a
 * URL, and the whole reason to reach for a transcript in a research run is the
 * cases where it is a practitioner talking about something no article covers.
 * The floor makes that distinction cheap and states it in the output, so a
 * reader can see what was excluded rather than assuming the web had nothing.
 *
 * Everything below was measured on 2 August 2026, not read from documentation.
 * YouTube's own endpoints are undocumented and move.
 */

import { z } from 'zod';
import { safeFetch } from '../net/safe-fetch.js';

/**
 * The default floor.
 *
 * Both at 30,000, which is the owner's number rather than a measured threshold.
 * Worth knowing what it does and does not buy: it filters out the long tail of
 * unwatched uploads, and it does nothing at all about whether the speaker is
 * right. Popularity is a proxy for having been checked by somebody, and a weak
 * one.
 */
export const DEFAULT_MIN_VIEWS = 30_000;
export const DEFAULT_MIN_SUBSCRIBERS = 30_000;

/**
 * The two InnerTube clients, and why there are two.
 *
 * `WEB` answers a search with view counts, publish times and the channel;
 * `IOS` answers with `videoId` and nothing else. `IOS` serves caption URLs that
 * return bytes; `WEB` serves caption URLs that return HTTP 200 and zero bytes.
 * So search is WEB and captions are IOS, and neither is a typo.
 */
const WEB_CLIENT = { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'en', gl: 'US' } as const;
const IOS_CLIENT = { clientName: 'IOS', clientVersion: '20.03.02', hl: 'en', gl: 'US' } as const;

const WEB_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const IOS_UA = 'com.google.ios.youtube/20.03.02 (iPhone16,2; U; CPU iOS 18_2_1 like Mac OS X)';

export class YouTubeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YouTubeError';
  }
}

export interface YouTubeHit {
  readonly videoId: string;
  readonly url: string;
  readonly title: string;
  readonly channel: string;
  readonly channelId: string;
  readonly views: number;
  /** YouTube's own words: "5 years ago". Kept verbatim because it is what was said. */
  readonly publishedText: string;
  readonly publishedDaysAgo: number;
  readonly durationSeconds: number;
  readonly subscribers?: number;
}

export interface YouTubeFilters {
  readonly minViews?: number | undefined;
  readonly minSubscribers?: number | undefined;
  readonly publishedWithinDays?: number | undefined;
  readonly minDurationSeconds?: number | undefined;
}

/** A count written for people, as a number. Undefined when unreadable. */
export function parseCount(text: string): number | undefined {
  const s = text.toLowerCase().replace(/,/g, '').trim();
  const worded = /(\d+(?:\.\d+)?)\s*(thousand|million|billion)/.exec(s);
  if (worded?.[1]) {
    const mult = worded[2] === 'billion' ? 1e9 : worded[2] === 'million' ? 1e6 : 1e3;
    return Math.round(Number(worded[1]) * mult);
  }
  const suffixed = /(\d+(?:\.\d+)?)\s*([kmb])\b/.exec(s);
  if (suffixed?.[1]) {
    const mult = suffixed[2] === 'b' ? 1e9 : suffixed[2] === 'm' ? 1e6 : 1e3;
    return Math.round(Number(suffixed[1]) * mult);
  }
  const plain = /(\d+)/.exec(s);
  return plain?.[1] ? Number(plain[1]) : undefined;
}

/**
 * "3 weeks ago" as days.
 *
 * Coarse, and the caller is told so. YouTube reports a rounded relative string,
 * never a date, so anything inside the current month reads as weeks at best. A
 * window of "the past month" is honest; "since the 14th" is not.
 */
export function parseRelativeDays(text: string): number {
  const m = /(\d+)\s*(second|minute|hour|day|week|month|year)/i.exec(text);
  if (!m?.[1]) return Number.POSITIVE_INFINITY;
  const n = Number(m[1]);
  switch (m[2]?.toLowerCase()) {
    case 'second':
    case 'minute':
    case 'hour':
      return 0;
    case 'day':
      return n;
    case 'week':
      return n * 7;
    case 'month':
      return n * 30;
    default:
      return n * 365;
  }
}

/** "1:04:28" as seconds. Zero for a live stream, which has no length. */
export function parseDuration(text: string): number {
  const parts = text.split(':').map((p) => Number(p.trim()));
  if (parts.some((p) => !Number.isFinite(p))) return 0;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

async function innertube(
  path: string,
  body: unknown,
  ua: string,
  timeoutMs: number,
  fetchImpl?: typeof fetch,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const res = await (fetchImpl ?? fetch)(`https://www.youtube.com/youtubei/v1/${path}?prettyPrint=false`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': ua },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (res.status === 429 || res.status === 403) {
      throw new YouTubeError(
        `YouTube declined the request (HTTP ${String(res.status)}). It refuses most datacentre addresses; a home connection is served normally, which is why this works locally and fails on a host.`,
      );
    }
    if (!res.ok) throw new YouTubeError(`InnerTube returned HTTP ${String(res.status)}.`);
    return await res.json();
  } catch (e: unknown) {
    if (e instanceof YouTubeError) throw e;
    if (e instanceof Error && e.name === 'AbortError') throw new YouTubeError('YouTube did not answer in time.');
    throw new YouTubeError(`Could not reach YouTube: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

const VideoRendererSchema = z.object({
  videoId: z.string(),
  title: z.object({ runs: z.array(z.object({ text: z.string() })).optional() }).optional(),
  viewCountText: z.object({ simpleText: z.string().optional() }).optional(),
  publishedTimeText: z.object({ simpleText: z.string().optional() }).optional(),
  lengthText: z.object({ simpleText: z.string().optional() }).optional(),
  ownerText: z
    .object({
      runs: z
        .array(
          z.object({
            text: z.string(),
            navigationEndpoint: z
              .object({ browseEndpoint: z.object({ browseId: z.string().optional() }).optional() })
              .optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

function collect(node: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const n of node) collect(n, key, out);
    return out;
  }
  if (typeof node !== 'object' || node === null) return out;
  const obj = node as Record<string, unknown>;
  if (obj[key] !== undefined) out.push(obj[key]);
  for (const v of Object.values(obj)) collect(v, key, out);
  return out;
}

/** The token for the next page, wherever the response chose to put it. */
function findContinuation(node: unknown): string | undefined {
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = findContinuation(n);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof node !== 'object' || node === null) return undefined;
  const obj = node as Record<string, unknown>;
  const cmd = obj['continuationCommand'];
  if (typeof cmd === 'object' && cmd !== null) {
    const token = (cmd as Record<string, unknown>)['token'];
    if (typeof token === 'string' && token !== '') return token;
  }
  for (const v of Object.values(obj)) {
    const found = findContinuation(v);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * One page of raw search results, unfiltered, plus the token for the next.
 *
 * A continuation request sends the token INSTEAD of the query, not alongside
 * it. Sending both returns page one again, which reads as a search with
 * nothing past the first nineteen results.
 */
export async function searchPage(
  query: string,
  opts: { continuation?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ hits: YouTubeHit[]; continuation?: string }> {
  const json = await innertube(
    'search',
    opts.continuation === undefined
      ? { query, context: { client: WEB_CLIENT } }
      : { continuation: opts.continuation, context: { client: WEB_CLIENT } },
    WEB_UA,
    opts.timeoutMs ?? 20_000,
    opts.fetchImpl,
  );

  const hits: YouTubeHit[] = [];
  for (const raw of collect(json, 'videoRenderer')) {
    const p = VideoRendererSchema.safeParse(raw);
    if (!p.success) continue;
    const r = p.data;
    const owner = r.ownerText?.runs?.[0];
    const publishedText = r.publishedTimeText?.simpleText ?? '';
    hits.push({
      videoId: r.videoId,
      url: `https://www.youtube.com/watch?v=${r.videoId}`,
      title: r.title?.runs?.map((x) => x.text).join('') ?? '',
      channel: owner?.text ?? '',
      channelId: owner?.navigationEndpoint?.browseEndpoint?.browseId ?? '',
      // An unreadable view count becomes zero, which fails the floor. That is
      // the safe direction: a video is excluded rather than admitted on a
      // number nobody read.
      views: parseCount(r.viewCountText?.simpleText ?? '') ?? 0,
      publishedText,
      publishedDaysAgo: publishedText === '' ? Number.POSITIVE_INFINITY : parseRelativeDays(publishedText),
      durationSeconds: parseDuration(r.lengthText?.simpleText ?? ''),
    });
  }
  const continuation = findContinuation(json);
  return continuation === undefined ? { hits } : { hits, continuation };
}

const HeaderSchema = z.object({
  header: z
    .object({
      pageHeaderRenderer: z
        .object({
          content: z
            .object({
              pageHeaderViewModel: z
                .object({
                  metadata: z
                    .object({
                      contentMetadataViewModel: z
                        .object({
                          metadataRows: z
                            .array(
                              z.object({
                                metadataParts: z
                                  .array(z.object({ text: z.object({ content: z.string().optional() }).optional() }))
                                  .optional(),
                              }),
                            )
                            .optional(),
                        })
                        .optional(),
                    })
                    .optional(),
                })
                .optional(),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

/**
 * The channel's own subscriber count, from the page header.
 *
 * NOT from `subscriberCountText`. A channel response carries several of those
 * and none of them belongs to the channel: they are the recommended-channel
 * sidebar. Measured on a channel with 4.24M subscribers, the two present were
 * 466 thousand and 49 thousand, either of which reads as a plausible answer.
 * The row is found by the word "subscriber" rather than by position, because
 * the handle, the count and the video total share that list in no guaranteed
 * order.
 */
export function subscribersFrom(json: unknown): number | undefined {
  const parsed = HeaderSchema.safeParse(json);
  if (!parsed.success) return undefined;
  const rows =
    parsed.data.header?.pageHeaderRenderer?.content?.pageHeaderViewModel?.metadata?.contentMetadataViewModel
      ?.metadataRows ?? [];
  for (const row of rows) {
    for (const part of row.metadataParts ?? []) {
      const content = part.text?.content ?? '';
      if (/subscriber/i.test(content)) return parseCount(content);
    }
  }
  return undefined;
}

export async function fetchSubscribers(
  channelId: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<number | undefined> {
  return subscribersFrom(
    await innertube(
      'browse',
      { browseId: channelId, context: { client: WEB_CLIENT } },
      WEB_UA,
      opts.timeoutMs ?? 20_000,
      opts.fetchImpl,
    ),
  );
}

/** Does this hit clear everything except the subscriber floor? */
export function passesCheapFloor(hit: YouTubeHit, f: YouTubeFilters): boolean {
  if (hit.views < (f.minViews ?? DEFAULT_MIN_VIEWS)) return false;
  if (f.publishedWithinDays !== undefined && hit.publishedDaysAgo > f.publishedWithinDays) return false;
  if (f.minDurationSeconds !== undefined && hit.durationSeconds < f.minDurationSeconds) return false;
  return true;
}

export interface Segment {
  readonly start: number;
  readonly text: string;
}

export interface Transcript {
  readonly languageCode: string;
  readonly generated: boolean;
  readonly segments: readonly Segment[];
}

const PlayerSchema = z.object({
  playabilityStatus: z.object({ status: z.string().optional() }).optional(),
  videoDetails: z.object({ lengthSeconds: z.string().optional() }).optional(),
  captions: z
    .object({
      playerCaptionsTracklistRenderer: z
        .object({
          captionTracks: z
            .array(
              z.object({
                baseUrl: z.string(),
                languageCode: z.string(),
                kind: z.string().optional(),
              }),
            )
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

/** What a caption fetch returns, narrow enough that a test can supply one. */
export interface CaptionResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: string;
}

/** 4 MB: a three-hour video's json3 runs well past `safeFetch`'s 512 KB default. */
const MAX_CAPTION_BYTES = 4 * 1024 * 1024;

async function defaultFetchCaption(url: string, timeoutMs: number): Promise<CaptionResponse> {
  const res = await safeFetch(url, { timeoutMs, maxBytes: MAX_CAPTION_BYTES });
  return { ok: res.ok, status: res.status, body: res.body };
}

/**
 * Fetch a transcript, or say why there is none.
 *
 * Through `IOS`, because the watch page's caption URLs are signed for the web
 * client and now answer HTTP 200 with zero bytes: a block indistinguishable
 * from a video with no captions unless the response length is checked.
 */
export async function fetchTranscript(
  videoId: string,
  languages: readonly string[],
  opts: {
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    fetchCaption?: (url: string, timeoutMs: number) => Promise<CaptionResponse>;
  } = {},
): Promise<Transcript> {
  const json = await innertube(
    'player',
    { videoId, context: { client: IOS_CLIENT } },
    IOS_UA,
    opts.timeoutMs ?? 20_000,
    opts.fetchImpl,
  );
  const parsed = PlayerSchema.safeParse(json);
  if (!parsed.success) throw new YouTubeError('YouTube returned player data in an unrecognised shape.');

  const status = parsed.data.playabilityStatus?.status;
  if (status !== undefined && status !== 'OK') {
    throw new YouTubeError(`YouTube will not serve this video (${status}). It may be private, age-restricted or region-blocked.`);
  }

  const tracks = parsed.data.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (tracks.length === 0) throw new YouTubeError('This video has no caption track.');

  const wants = languages.length > 0 ? languages : ['en'];
  const matches = (code: string, want: string): boolean =>
    code.toLowerCase() === want.toLowerCase() || code.toLowerCase().startsWith(`${want.toLowerCase()}-`);
  let track = tracks.find((t) => t.kind !== 'asr' && wants.some((w) => matches(t.languageCode, w)));
  track ??= tracks.find((t) => wants.some((w) => matches(t.languageCode, w)));
  track ??= tracks.find((t) => t.kind !== 'asr') ?? tracks[0];
  if (!track) throw new YouTubeError('This video has no caption track.');

  const url = track.baseUrl.includes('fmt=') ? track.baseUrl : `${track.baseUrl}&fmt=json3`;

  // Through `safeFetch`, unlike the InnerTube calls above.
  //
  // The difference is who chose the URL. Those go to a constant on
  // youtube.com; this one is a `baseUrl` YouTube handed back, so it is
  // attacker-influenced input by the same reading that governs a citation
  // URL — a weak threat, and exactly the reading CP §4 A10 asks for. The cap
  // is raised well above the default because a three-hour video's json3
  // legitimately runs past 512 KB and a truncated transcript would parse as a
  // short one.
  let body: string;
  try {
    const res = await (opts.fetchCaption ?? defaultFetchCaption)(url, opts.timeoutMs ?? 20_000);
    if (!res.ok) throw new YouTubeError(`The caption track returned HTTP ${String(res.status)}.`);
    body = res.body;
  } catch (e: unknown) {
    if (e instanceof YouTubeError) throw e;
    throw new YouTubeError(`Could not fetch the caption track: ${e instanceof Error ? e.message : String(e)}`);
  }

  const segments = parseJson3(body);
  if (segments.length === 0) {
    throw new YouTubeError(
      'The caption track was served but empty, which is what a proof-of-origin block looks like from here.',
    );
  }
  return { languageCode: track.languageCode, generated: track.kind === 'asr', segments };
}

/** Parse the json3 caption format the iOS client serves. */
export function parseJson3(body: string): Segment[] {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return [];
  }
  const shape = z
    .object({
      events: z
        .array(
          z.object({
            tStartMs: z.number().optional(),
            segs: z.array(z.object({ utf8: z.string().optional() })).optional(),
          }),
        )
        .optional(),
    })
    .safeParse(doc);
  if (!shape.success) return [];

  const out: Segment[] = [];
  for (const e of shape.data.events ?? []) {
    const text = (e.segs ?? []).map((s) => s.utf8 ?? '').join('').replace(/\s+/g, ' ').trim();
    if (text === '' || e.tStartMs === undefined) continue;
    out.push({ start: e.tStartMs / 1000, text });
  }
  return out;
}

export interface GatheredVideo extends YouTubeHit {
  readonly transcript?: Transcript;
  /** Why there is no transcript, when there is none. */
  readonly unreadable?: string;
}

export interface GatherOutcome {
  readonly videos: readonly GatheredVideo[];
  /** How many raw results were read to find them. */
  readonly scanned: number;
  /** How many were dropped by the quality floor, which is the number worth reporting. */
  readonly belowFloor: number;
  readonly channelLookups: number;
  readonly pages: number;
  /** True when the page ceiling stopped the search before it ran out of results. */
  readonly hitPageLimit: boolean;
  readonly minViews: number;
  readonly minSubscribers: number;
}

/**
 * Search, apply the floor, read the transcripts.
 *
 * The order is the cost model. Views and recency come back with the search
 * response, so they run first and free. Subscriber count costs a browse request
 * per distinct channel, so it runs over what survives, once per channel. The
 * transcript is fetched last, only for videos that cleared both.
 *
 * `maxPages` is a real ceiling rather than a suggestion. A strict floor on a
 * niche topic matches nothing, and without a bound that is an unbounded walk
 * through YouTube's result set at one browse request per new channel. When the
 * ceiling is what stopped the search the outcome says so, because "nothing
 * cleared the floor" and "we stopped looking" are different answers.
 */
export async function gather(
  query: string,
  filters: YouTubeFilters,
  opts: {
    limit?: number;
    maxPages?: number;
    languages?: readonly string[];
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    fetchCaption?: (url: string, timeoutMs: number) => Promise<CaptionResponse>;
  } = {},
): Promise<GatherOutcome> {
  const minViews = filters.minViews ?? DEFAULT_MIN_VIEWS;
  const minSubscribers = filters.minSubscribers ?? DEFAULT_MIN_SUBSCRIBERS;
  const limit = opts.limit ?? 5;
  const maxPages = opts.maxPages ?? 4;
  const languages = opts.languages ?? ['en'];
  const pass = { ...filters, minViews };
  const net = {
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  };

  const subs = new Map<string, number | undefined>();
  const kept: YouTubeHit[] = [];
  const seenVideos = new Set<string>();
  let scanned = 0;
  let belowFloor = 0;
  let pages = 0;
  let continuation: string | undefined;
  let exhausted = false;

  while (kept.length < limit && pages < maxPages) {
    const page = await searchPage(query, {
      ...net,
      ...(continuation === undefined ? {} : { continuation }),
    });
    pages += 1;

    for (const hit of page.hits) {
      if (kept.length >= limit) break;
      // A continuation can repeat a video it already returned, and a repeat
      // counted twice inflates both `scanned` and `belowFloor`, which are the
      // numbers a reader uses to judge coverage.
      if (seenVideos.has(hit.videoId)) continue;
      seenVideos.add(hit.videoId);
      scanned += 1;

      if (!passesCheapFloor(hit, pass) || hit.channelId === '') {
        belowFloor += 1;
        continue;
      }
      if (!subs.has(hit.channelId)) {
        try {
          subs.set(hit.channelId, await fetchSubscribers(hit.channelId, net));
        } catch {
          subs.set(hit.channelId, undefined);
        }
      }
      const n = subs.get(hit.channelId);
      if (n === undefined || n < minSubscribers) {
        belowFloor += 1;
        continue;
      }
      kept.push({ ...hit, subscribers: n });
    }

    if (page.continuation === undefined) {
      exhausted = true;
      break;
    }
    continuation = page.continuation;
  }

  const videos = await Promise.all(
    kept.map(async (hit): Promise<GatheredVideo> => {
      try {
        return {
          ...hit,
          transcript: await fetchTranscript(hit.videoId, languages, {
            ...net,
            ...(opts.fetchCaption ? { fetchCaption: opts.fetchCaption } : {}),
          }),
        };
      } catch (e: unknown) {
        return { ...hit, unreadable: e instanceof Error ? e.message : String(e) };
      }
    }),
  );

  return {
    videos,
    scanned,
    belowFloor,
    channelLookups: subs.size,
    pages,
    hitPageLimit: !exhausted && kept.length < limit,
    minViews,
    minSubscribers,
  };
}

/** The gather as text a research run can cite from. */
export function renderGather(query: string, outcome: GatherOutcome, maxCharsPerVideo = 8_000): string[] {
  const readable = outcome.videos.filter((v) => v.transcript);
  const lines: string[] = [
    `## YouTube: ${String(readable.length)} transcript(s) for "${query}"`,
    '',
    `Read ${String(outcome.scanned)} search result(s) across ${String(outcome.pages)} page(s); ` +
      `${String(outcome.belowFloor)} fell below the floor of ` +
      `${outcome.minViews.toLocaleString()} views and ${outcome.minSubscribers.toLocaleString()} subscribers. ` +
      `${String(outcome.channelLookups)} channel lookup(s). Free, no key.`,
    '',
    '> [!NOTE]',
    '> A view count is a proxy for having been checked by somebody, and a weak one. The floor removes the long ' +
      'tail of unwatched uploads; it says nothing about whether the speaker is right. Cite a transcript as what one ' +
      'person said on camera, which is what it is.',
  ];

  if (outcome.hitPageLimit) {
    // "We stopped looking" and "there is nothing there" are different answers
    // and only one of them is a fact about the subject.
    lines.push(
      '',
      `_Stopped at the ${String(outcome.pages)}-page ceiling with results still unread, so this is not the ` +
        'whole of what YouTube holds. Raise `maxPages` or lower the floor if the shortfall matters._',
    );
  }

  if (readable.length === 0) {
    lines.push(
      '',
      'Nothing cleared the floor with a readable transcript. Lower `minViews` or `minSubscribers` if the topic is ' +
        'genuinely niche, and treat the absence as a fact about YouTube rather than about the subject.',
    );
  }

  for (const v of outcome.videos) {
    lines.push(
      '',
      '---',
      '',
      `### ${v.title}`,
      `${v.url}`,
      `${v.channel}${v.subscribers === undefined ? '' : ` · ${v.subscribers.toLocaleString()} subscribers`} · ` +
        `${v.views.toLocaleString()} views · ${v.publishedText}`,
    );
    if (!v.transcript) {
      lines.push('', `_No transcript: ${v.unreadable ?? 'unknown'}_`);
      continue;
    }
    const text = v.transcript.segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
    const clipped = text.length > maxCharsPerVideo;
    lines.push(
      `_${v.transcript.generated ? 'Auto-generated' : 'Human-written'} captions (${v.transcript.languageCode})._`,
      '',
      clipped ? `${text.slice(0, maxCharsPerVideo)}\n\n_[transcript truncated at ${String(maxCharsPerVideo)} characters]_` : text,
    );
  }
  return lines;
}
