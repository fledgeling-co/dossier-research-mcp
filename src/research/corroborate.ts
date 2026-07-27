/**
 * Comparing two backends' answers to the same question.
 *
 * The conflicts are the output. Two well-resourced research agents disagreeing
 * about a number tells you where the uncertainty actually sits, and it is the
 * one thing a single-provider tool can never show you.
 */

export interface ProviderClaim {
  readonly provider: string;
  readonly text: string;
  readonly urls: readonly string[];
}

export type Support = 'corroborated' | 'weakly-supported' | 'single-source' | 'unsupported';

export interface CorroborationVerdict {
  readonly claim: string;
  readonly providers: readonly string[];
  /** Distinct registrable domains, after canonicalisation. */
  readonly independentDomains: number;
  readonly support: Support;
  readonly note?: string;
}

/**
 * Canonicalise a URL so two spellings of one page collapse.
 *
 * Tracking parameters, `www.`, trailing slashes and fragments all produce
 * different strings for identical content, and every one of them would
 * otherwise read as an extra independent source.
 */
export function canonicaliseUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    u.hostname = u.hostname.replace(/^www\./i, '').toLowerCase();
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref|source$)/i.test(p)) u.searchParams.delete(p);
    }
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    return u.toString();
  } catch {
    return raw.trim();
  }
}

/**
 * The registrable domain, approximately.
 *
 * Deliberately crude: a full public-suffix list is a dependency and a
 * maintenance burden for a heuristic whose only job is to stop `docs.x.com` and
 * `blog.x.com` counting as two independent sources. Two-label public suffixes
 * (`co.uk`, `com.au`) are handled explicitly because they are common enough
 * that getting them wrong would visibly overcount UK and Australian sources.
 */
export function registrableDomain(raw: string): string {
  let host: string;
  try {
    host = new URL(raw).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const twoLabelSuffix = /^(co|com|org|net|gov|edu|ac)\.[a-z]{2}$/;
  const lastTwo = parts.slice(-2).join('.');
  return twoLabelSuffix.test(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

/**
 * How much independent support a claim actually has.
 *
 * **The rule this exists for:** cross-provider agreement is not independent
 * evidence if both providers read the same page. Three deep-research agents
 * citing one vendor press release is one source with three wrappers, and a
 * naive "3 of 3 agree" score is actively misleading. Corroboration is therefore
 * counted in independent *domains* after canonicalisation, never in providers
 * and never in raw URLs.
 *
 * Syndication defeats even this: one wire story republished across twenty
 * outlets is twenty domains and one source. That is flagged rather than solved,
 * because solving it properly needs provenance the sources rarely publish.
 */
export function assessSupport(claims: readonly ProviderClaim[]): CorroborationVerdict {
  const providers = [...new Set(claims.map((c) => c.provider))];
  const domains = new Set<string>();
  for (const c of claims) {
    for (const u of c.urls) {
      // Model output, so "unknown", "N/A" and "source unavailable" all arrive
      // here looking like sources. Counted as domains, three of those made a
      // claim `corroborated` on the strength of three admissions that there
      // was no source. Only a resolvable http(s) URL counts.
      if (!isHttpUrl(u)) continue;
      domains.add(registrableDomain(canonicaliseUrl(u)));
    }
  }

  const independentDomains = domains.size;
  const text = claims[0]?.text ?? '';

  if (independentDomains === 0) {
    return {
      claim: text,
      providers,
      independentDomains,
      support: 'unsupported',
      note: 'No resolvable source. Never present this as a finding.',
    };
  }
  if (independentDomains === 1) {
    return {
      claim: text,
      providers,
      independentDomains,
      support: 'single-source',
      ...(providers.length > 1
        ? {
            note: `${String(providers.length)} backends agree, but they cite the same domain, so this is one source rather than ${String(providers.length)}.`,
          }
        : {}),
    };
  }
  return {
    claim: text,
    providers,
    independentDomains,
    support: independentDomains >= 3 ? 'corroborated' : 'weakly-supported',
    ...(looksSyndicated(claims)
      ? {
          note: 'Sources are near-identical in wording, which is the signature of a syndicated wire story. Independence is unestablished.',
        }
      : {}),
  };
}

/** Is this a real http(s) URL, rather than a model's way of saying "none"? */
export function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.includes('.');
  } catch {
    return false;
  }
}

/** A crude wire-story detector: near-identical claim text across providers. */
function looksSyndicated(claims: readonly ProviderClaim[]): boolean {
  if (claims.length < 2) return false;
  const norm = (s: string) => s.toLowerCase().replace(/\W+/g, ' ').trim();
  const first = norm(claims[0]!.text);
  return claims.slice(1).every((c) => {
    const other = norm(c.text);
    if (first.length < 40 || other.length < 40) return false;
    const shorter = first.length < other.length ? first : other;
    const longer = first.length < other.length ? other : first;
    return longer.includes(shorter.slice(0, Math.floor(shorter.length * 0.8)));
  });
}

/** A claim set from one backend, ready to compare against the others. */
export interface ProviderClaimSet {
  readonly provider: string;
  readonly claims: readonly ProviderClaim[];
}

export interface CrossCheck {
  /** Claims more than one backend made, with their independence assessed. */
  readonly shared: CorroborationVerdict[];
  /** Claims exactly one backend made. Coverage gaps, not errors. */
  readonly unique: { provider: string; claims: ProviderClaim[] }[];
}

/** Loose match key: enough to spot the same claim worded slightly differently. */
function claimKey(c: ProviderClaim): string {
  return c.text.toLowerCase().replace(/\W+/g, ' ').trim().slice(0, 120);
}

/**
 * Words that carry no evidence of what a claim is about.
 *
 * Deliberately short. An aggressive stopword list starts deleting the words
 * that distinguish two claims ("not", "before", "less"), and a negation
 * stripped out is how "X causes Y" and "X does not cause Y" become the same
 * fingerprint.
 */
const NOISE = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'that',
  'this', 'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been', 'as', 'at',
  'by', 'from', 'it', 'its', 'their', 'which', 'than', 'then', 'so', 'but',
]);

/**
 * The tokens that decide what a claim is *about*: numbers, and content words.
 *
 * Numbers are kept whole and weighted by being rare. Two claims sharing "0.6B"
 * and "GRPO" are almost certainly the same claim however differently they are
 * written; two sharing only "model" and "training" are almost certainly not.
 */
function salientTokens(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    // Split hyphens. "from-scratch" and "from scratch" are the same claim, and
    // one backend hyphenating what another spaced is not a difference of
    // substance. Keeps a decimal like 0.6b intact.
    .replace(/[^\p{L}\p{N}.%]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !NOISE.has(w))
    // Minimal stemming: enough that "fine-tuning" meets "fine-tune", not so
    // much that unrelated words collide. Only the three endings that actually
    // caused misses on real claims, and only on words long enough that removing
    // them leaves something meaningful.
    .map((w) => (w.length > 5 ? w.replace(/(ing|ed|s)$/, '') : w));
  return new Set(tokens);
}

/**
 * Overlap between two claims, weighting a token by how rare it is in the set.
 *
 * Plain Jaccard treats "0.6B" and "model" as equally informative, and they are
 * not: the first two backends to agree on a specific figure have said something,
 * while two that both say "model" have not. Real claims from one panel run
 * scored 0.30 on plain Jaccard while sharing `0.6b`, `decoder`, `scratch` and
 * `frontier`, which is unmistakably the same finding. Lowering the threshold to
 * admit it would have admitted far more noise with it; weighting by rarity
 * separates the two properly instead.
 *
 * `df` is the document frequency of each token across the claims being
 * compared. A token in most claims is nearly free; a token in two is expensive.
 */
function tokenOverlap(a: string, b: string, df?: ReadonlyMap<string, number>, total = 2): number {
  const x = salientTokens(a);
  const y = salientTokens(b);
  if (x.size === 0 || y.size === 0) return 0;

  // Rarity: a token in every claim scores near 0, a token in one or two near 1.
  const weight = (tok: string): number => {
    const seen = df?.get(tok) ?? 1;
    return Math.log((total + 1) / (seen + 0.5)) / Math.log(total + 1);
  };
  const sum = (set: Iterable<string>): number => {
    let n = 0;
    for (const tok of set) n += weight(tok);
    return n;
  };

  let sharedWeight = 0;
  for (const tok of x) if (y.has(tok)) sharedWeight += weight(tok);
  const union = sum(x) + sum(y) - sharedWeight;
  return union === 0 ? 0 : sharedWeight / union;
}

/** How many claims each token appears in. The rarity signal. */
function documentFrequency(texts: readonly string[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const text of texts) {
    for (const tok of salientTokens(text)) df.set(tok, (df.get(tok) ?? 0) + 1);
  }
  return df;
}

/** A pair of claims from different backends that look like the same claim. */
export interface ConvergenceCandidate {
  readonly claims: readonly ProviderClaim[];
  readonly providers: readonly string[];
  /** 0 to 1, Jaccard over salient tokens. Shown so a reader can discount it. */
  readonly overlap: number;
  /** The tokens both sides carried. This is the evidence, not the score. */
  readonly sharedTokens: readonly string[];
}

/**
 * Find claims several backends appear to have made, by what they are about
 * rather than by how they are worded.
 *
 * This exists because exact-wording matching reported zero every time and the
 * zero was then rendered as "these reports do not overlap", which is a
 * confident negative produced by a test with no power to find a positive. Five
 * backends never phrase a conclusion identically.
 *
 * It is a candidate list, never a verdict. The overlap score and the shared
 * tokens are both returned so a reader can see *why* two claims were paired and
 * disagree. Raising this to an assertion would trade a false negative for a
 * false positive, and an overstated convergence is the worse of the two: it is
 * the corroboration trap, arrived at by arithmetic instead of by credulity.
 */
export function findConvergence(
  sets: readonly ProviderClaimSet[],
  threshold = 0.2,
): ConvergenceCandidate[] {
  const flat = sets.flatMap((s) => s.claims.map((c) => ({ claim: c, provider: s.provider })));
  const df = documentFrequency(flat.map((f) => f.claim.text));
  const n = flat.length;
  const used = new Set<number>();
  const out: ConvergenceCandidate[] = [];

  for (let i = 0; i < flat.length; i += 1) {
    if (used.has(i)) continue;
    const group = [flat[i]!];
    for (let j = i + 1; j < flat.length; j += 1) {
      if (used.has(j)) continue;
      // Same backend saying something twice is not convergence.
      if (group.some((g) => g.provider === flat[j]!.provider)) continue;
      if (tokenOverlap(flat[i]!.claim.text, flat[j]!.claim.text, df, n) >= threshold) {
        group.push(flat[j]!);
        used.add(j);
      }
    }
    if (group.length < 2) continue;
    used.add(i);
    const shared = [...salientTokens(group[0]!.claim.text)].filter((tok) =>
      group.every((g) => salientTokens(g.claim.text).has(tok)),
    );
    const pairwise = tokenOverlap(group[0]!.claim.text, group[1]!.claim.text, df, n);
    out.push({
      claims: group.map((g) => g.claim),
      providers: [...new Set(group.map((g) => g.provider))],
      overlap: Math.round(pairwise * 100) / 100,
      sharedTokens: shared.slice(0, 12),
    });
  }
  return out.sort((a, b) => b.providers.length - a.providers.length || b.overlap - a.overlap);
}

/**
 * Compare N backends' claim sets.
 *
 * The unique lists matter as much as the shared ones, and are easy to
 * under-read: a claim only one backend made is usually a coverage difference
 * rather than a mistake, so it is reported as a gap rather than scored down.
 * What it is *not* is corroborated, and `assessSupport` is what says so.
 */
export function crossCheck(sets: readonly ProviderClaimSet[]): CrossCheck {
  const groups = new Map<string, ProviderClaim[]>();
  for (const set of sets) {
    for (const claim of set.claims) {
      const key = claimKey(claim);
      const bucket = groups.get(key);
      if (bucket) bucket.push(claim);
      else groups.set(key, [claim]);
    }
  }

  const shared: CorroborationVerdict[] = [];
  const uniqueBy = new Map<string, ProviderClaim[]>(sets.map((s) => [s.provider, []]));
  for (const bucket of groups.values()) {
    const providers = new Set(bucket.map((c) => c.provider));
    if (providers.size > 1) {
      shared.push(assessSupport(bucket));
      continue;
    }
    const only = bucket[0]?.provider ?? '';
    const list = uniqueBy.get(only);
    if (list) list.push(...bucket);
    else uniqueBy.set(only, [...bucket]);
  }

  return {
    shared,
    unique: [...uniqueBy].map(([provider, claims]) => ({ provider, claims })),
  };
}

/**
 * The two-backend case, in the shape the comparison report wants.
 * A thin projection of `crossCheck` so both paths share one matcher.
 */
export function diffClaims(
  a: ProviderClaimSet,
  b: ProviderClaimSet,
): {
  agreed: CorroborationVerdict[];
  onlyA: ProviderClaim[];
  onlyB: ProviderClaim[];
} {
  const { shared, unique } = crossCheck([a, b]);
  const find = (provider: string): ProviderClaim[] =>
    unique.find((u) => u.provider === provider)?.claims ?? [];
  return { agreed: shared, onlyA: find(a.provider), onlyB: find(b.provider) };
}
