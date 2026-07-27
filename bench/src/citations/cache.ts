import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RegistryAnswerSchema, type RegistryAnswer } from './evidence.js';
import { REGISTRY_GAP_MS, type RegistryId } from './registries.js';
import type { IdentifierKind } from '../score/identifiers.js';

/**
 * Remembering a registry answer, and spacing the requests that produce one.
 *
 * The only file in this directory that touches a disk, on the same principle
 * that keeps `bench/src/tasks/files.ts` alone in its slice: the rules are the
 * part worth testing and the adapter around them stays thin enough to read in
 * one sitting.
 *
 * **An `unchecked` answer is never written.** That is the first rule of the
 * slice wearing a different hat. Caching a transient outage would freeze a
 * moment when a server was busy into a permanent verdict about somebody's
 * citation, and the next forty reports would inherit it without a single one of
 * them making a request that could correct it.
 */

/** The identity a lookup is remembered under. Namespaced so two kinds cannot collide. */
export function cacheKey(kind: IdentifierKind, id: string): string {
  // Hashed rather than used raw: a DOI's own slashes, brackets and dots are
  // legal in the identifier and are not legal as a file name, and building a
  // path out of untrusted text is how a cache write escapes its directory.
  const digest = createHash('sha256').update(id).digest('hex').slice(0, 40);
  return `${kind}/${digest}.json`;
}

/**
 * Where remembered answers live by default.
 *
 * Beside the existing run store rather than inside the checkout, so scoring a
 * batch never dirties a working copy or turns up in a diff. A parameter with a
 * default rather than an environment variable, because `src/config.ts` is the
 * only place this repo reads the environment and the benchmark is not the
 * server.
 */
export function defaultCacheDir(): string {
  return join(homedir(), '.dossier-research-mcp', 'bench', 'registry-cache');
}

export interface RegistryCache {
  get(kind: IdentifierKind, id: string): RegistryAnswer | undefined;
  set(answer: RegistryAnswer): void;
}

/** A cache that forgets, for tests and for a deliberately cold run. */
export class MemoryRegistryCache implements RegistryCache {
  private readonly entries = new Map<string, RegistryAnswer>();

  get(kind: IdentifierKind, id: string): RegistryAnswer | undefined {
    return this.entries.get(cacheKey(kind, id));
  }

  set(answer: RegistryAnswer): void {
    if (answer.status === 'unchecked') return;
    this.entries.set(cacheKey(answer.kind, answer.id), answer);
  }
}

/**
 * The on-disk cache: one small JSON file per identifier.
 *
 * Written under a temporary name and renamed into place, the same atomic
 * pattern `src/store/store.ts` uses, so a crash mid-write leaves the previous
 * answer rather than a half-written one. Read back it is a trust boundary and
 * is Zod-parsed; an entry that does not parse, or whose recorded identity
 * disagrees with what was asked for, is discarded and looked up again rather
 * than trusted, because a hand-edited or truncated file must not be able to
 * assert that somebody's citation was fabricated.
 */
export class DiskRegistryCache implements RegistryCache {
  private readonly dir: string;

  constructor(dir: string = defaultCacheDir()) {
    this.dir = dir;
  }

  get(kind: IdentifierKind, id: string): RegistryAnswer | undefined {
    let raw: string;
    try {
      raw = readFileSync(join(this.dir, cacheKey(kind, id)), 'utf8');
    } catch {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
    const result = RegistryAnswerSchema.safeParse(parsed);
    if (!result.success) return undefined;
    if (result.data.kind !== kind || result.data.id !== id) return undefined;
    if (result.data.status === 'unchecked') return undefined;
    return result.data;
  }

  set(answer: RegistryAnswer): void {
    if (answer.status === 'unchecked') return;
    const relative = cacheKey(answer.kind, answer.id);
    const target = join(this.dir, relative);
    const temp = `${target}.${String(process.pid)}.${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 8)}.tmp`;
    try {
      mkdirSync(join(this.dir, answer.kind), { recursive: true });
      writeFileSync(temp, `${JSON.stringify(answer)}\n`, 'utf8');
      renameSync(temp, target);
    } catch {
      // A cache that cannot be written is a slower benchmark, never a wrong
      // one. Swallowed on purpose, and the only swallowed error in the slice.
    }
  }
}

/** Injected so a test does not wait three seconds for arXiv's stated gap. */
export type Sleeper = (ms: number) => Promise<void>;

export const realSleeper: Sleeper = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * One minimum gap per registry, shared across every worker.
 *
 * Per worker would not be the limit the service asked for: eight concurrent
 * cells each honouring a three-second gap is eight requests every three
 * seconds. The queue is a promise chain per registry, so the gap holds however
 * many callers are waiting and whatever order they arrived in.
 */
export class RateLimiter {
  private readonly gaps: Record<string, number>;
  private readonly tails = new Map<string, Promise<void>>();
  private readonly lastStart = new Map<string, number>();
  private readonly sleep: Sleeper;
  private readonly now: () => number;

  constructor(options: {
    readonly gaps?: Partial<Record<RegistryId, number>> | undefined;
    readonly sleep?: Sleeper | undefined;
    readonly now?: (() => number) | undefined;
  } = {}) {
    this.gaps = { ...REGISTRY_GAP_MS, ...options.gaps };
    this.sleep = options.sleep ?? realSleeper;
    this.now = options.now ?? Date.now;
  }

  /** Run `work` no sooner than this registry's gap after the previous call. */
  async schedule<T>(registry: RegistryId, work: () => Promise<T>): Promise<T> {
    const gap = this.gaps[registry] ?? 0;
    const previous = this.tails.get(registry) ?? Promise.resolve();
    let release = (): void => undefined;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(registry, previous.then(() => mine));

    await previous;
    const last = this.lastStart.get(registry);
    if (last !== undefined) {
      const waited = this.now() - last;
      if (waited < gap) await this.sleep(gap - waited);
    }
    this.lastStart.set(registry, this.now());
    try {
      return await work();
    } finally {
      release();
    }
  }
}

/**
 * Collapse concurrent callers asking for the same thing onto one call.
 *
 * The brief's requirement is that the same DOI across forty reports is one
 * lookup, and a disk cache alone does not deliver that: two cells running at
 * once both miss, both request, and both write. This is the in-process half.
 *
 * A cross-process lock is deliberately **not** here. The harness is one process
 * with bounded concurrency, so the case does not arise, and building a lock for
 * it would be exactly the speculative abstraction `CLAUDE.md` forbids. If the
 * harness ever forks, this is the paragraph to come back to.
 */
export class SingleFlight {
  private readonly inFlight = new Map<string, Promise<RegistryAnswer>>();

  run(key: string, work: () => Promise<RegistryAnswer>): Promise<RegistryAnswer> {
    const existing = this.inFlight.get(key);
    if (existing !== undefined) return existing;
    const started = work().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, started);
    return started;
  }
}
