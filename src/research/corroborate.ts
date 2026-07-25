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
  for (const c of claims) for (const u of c.urls) domains.add(registrableDomain(canonicaliseUrl(u)));

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
