import { randomUUID } from 'node:crypto';
import { link, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';

/**
 * A cross-process advisory lock, scoped to one store directory.
 *
 * The spend and concurrency gates were serialised by an in-process mutex, which
 * is correct for one server and useless for the case that actually happens: two
 * MCP clients (Claude Code and Cursor, say) both configured with Dossier are two
 * processes sharing the default store. Each holds its own mutex, each observes
 * $95 of a $100 ceiling, and each admits another $7 run. "One process per
 * client" makes multiple writers *more* likely, not less.
 *
 * ## Why a lock file rather than SQLite
 *
 * SQLite with `BEGIN IMMEDIATE` is the more general answer and is now in the
 * standard library (`node:sqlite`), so the dependency argument against it is
 * gone. It is still the wrong trade here. The store is deliberately plain JSON
 * and JSONL that a user can read, diff and delete by hand, and that property is
 * worth more than generality for a tool whose main risk is spending money
 * opaquely. Moving admission control to a database would also mean migrating
 * every existing v0.2.1 store.
 *
 * A lock file closes the specific race for about eighty lines, changes no data
 * format, and leaves the door open: if the other read-modify-write paths
 * (refresh, cancellation, journal appends) ever need the same guarantee, that
 * is the point to reconsider SQLite.
 *
 * ## Why write-then-link rather than O_EXCL create
 *
 * `open(path, 'wx')` is an atomic check-and-create, but the holder record is
 * written by a *second* syscall, so between the two the lock file exists and is
 * empty. A contender reading it in that window parses nothing, concludes the
 * lock is abandoned, deletes it and takes it. Two holders, which is exactly the
 * failure this class exists to prevent, and it is timing-dependent enough to
 * pass a test suite repeatedly before it does not.
 *
 * `link()` closes the window: the record is written to a temporary name first,
 * so at the instant the lock path appears it already has its contents, and
 * `link` fails with EEXIST when the target exists. The file therefore never
 * exists in a half-written state, and an unparseable lock file is genuine
 * corruption rather than a race.
 *
 * ## What this is not
 *
 * `link()` is atomic on local filesystems. It is not reliable on NFS, and this
 * makes no attempt to be. The store is a local per-user directory; if someone
 * points `DOSSIER_STORE_DIR` at a network share, the guarantee weakens to what
 * it was before, which is still no worse than not having it.
 */

export interface FileLockOptions {
  /** Give up acquiring after this long. */
  readonly timeoutMs?: number;
  /** A lock older than this is presumed abandoned. */
  readonly staleMs?: number;
  /** How long an unreadable lock file must sit unchanged before it is broken. */
  readonly graceMs?: number;
  /** Injectable for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; returns true when the pid is alive. */
  readonly isAlive?: (pid: number) => boolean;
}

interface LockHolder {
  readonly pid: number;
  readonly host: string;
  readonly at: number;
  /**
   * Who holds it, unforgeably.
   *
   * Without this, release is "delete the path", which deletes whoever holds it
   * *now* rather than whoever held it when we acquired. If B breaks A's lock on
   * age and A then releases, A deletes B's lock and C walks in beside B. Two
   * processes in the spend gate, from a release that looked correct.
   *
   * Optional because a lock written by a version that predates it is still a
   * lock. Treating one as unreadable would break it after the grace window even
   * while its owner was alive and working, which is precisely the failure this
   * field was added to prevent, arriving during an upgrade instead.
   */
  readonly token?: string;
}

/** Makes the temp name unique within a process; the pid covers across them. */
let tempCounter = 0;

const DEFAULT_TIMEOUT_MS = 15_000;
/**
 * Generous, because the critical section reads the ledger and the run directory
 * off disk. Too short and a slow-but-healthy holder gets its lock stolen, which
 * is worse than waiting: two processes would then be inside the gate at once,
 * the exact thing this prevents.
 */
const DEFAULT_STALE_MS = 60_000;

/**
 * Grace before an *unreadable* lock file is broken.
 *
 * Belt and braces with write-then-link. Link removes the half-written window
 * here, but a lock file left by an older version, a crashed writer, or a
 * filesystem where link is not atomic can still be observed mid-write, and the
 * old behaviour was to break it instantly — turning one damaged byte into two
 * holders inside the spend gate. A quarter of a second is far longer than any
 * write takes and far shorter than a human notices.
 */
const DEFAULT_GRACE_MS = 250;

/**
 * Deliberately NOT `unref`'d.
 *
 * An unref'd timer does not hold the event loop open, so a process whose only
 * pending work is "wait to acquire the lock" exits instead of waiting. Node
 * reports that as exit code 13, unsettled top-level await, and the caller's
 * promise never settles. Every other timer in this codebase is unref'd so the
 * server can exit when its client disconnects; this one must not be, because
 * here the wait *is* the work.
 */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Is a process still running? Signal 0 tests existence without delivering. */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    // EPERM means it exists and belongs to someone else, so it is alive.
    return (e as { code?: string }).code === 'EPERM';
  }
}

export class LockTimeoutError extends Error {
  readonly code = 'lock_timeout' as const;
  constructor(path: string, holder: LockHolder | null) {
    super(
      holder
        ? `Timed out waiting for the store lock at ${path}, held by pid ${holder.pid} on ${holder.host}. ` +
            'Another Dossier process is mid-transaction. If it has crashed, delete that file.'
        : `Timed out waiting for the store lock at ${path}.`,
    );
    this.name = 'LockTimeoutError';
  }
}

export class FileLock {
  /** The token written when this instance last acquired. */
  private token: string | null = null;

  constructor(
    private readonly path: string,
    private readonly opts: FileLockOptions = {},
  ) {}

  /**
   * Run `task` while holding the lock. Always released, including on throw,
   * because a lock leaked by an error path wedges every other process until the
   * staleness timeout expires.
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      await this.release();
    }
  }

  private async acquire(): Promise<void> {
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const staleMs = this.opts.staleMs ?? DEFAULT_STALE_MS;
    const graceMs = this.opts.graceMs ?? DEFAULT_GRACE_MS;
    const sleep = this.opts.sleep ?? defaultSleep;
    const isAlive = this.opts.isAlive ?? defaultIsAlive;
    const deadline = Date.now() + timeoutMs;
    let waitMs = 15;

    for (;;) {
      // Fully-written temp file first, then an atomic link into place. See the
      // header: creating the lock path empty and filling it afterwards leaves a
      // window in which a contender reads nothing and breaks a live lock.
      const temp = `${this.path}.${String(process.pid)}.${String((tempCounter += 1))}.tmp`;
      try {
        const token = randomUUID();
        const holder: LockHolder = { pid: process.pid, host: hostname(), at: Date.now(), token };
        await writeFile(temp, JSON.stringify(holder), { mode: 0o600 });
        await link(temp, this.path);
        this.token = token;
        return;
      } catch (e: unknown) {
        if ((e as { code?: string }).code !== 'EEXIST') throw e;
      } finally {
        // The lock now has its own name; the temp one is redundant either way.
        await rm(temp, { force: true }).catch(() => undefined);
      }

      const lastHolder = await this.readHolder();
      const abandoned =
        lastHolder === null
          ? // Unreadable. Not necessarily corrupt: it may be a lock being
            // written this instant. Break it only once it has sat unchanged
            // past the grace window, so a half-written file costs a short wait
            // rather than admitting a second holder.
            (await this.ageMs()) >= graceMs
          : // A holder we can prove is alive is never broken on age alone. The
            // critical section reads the ledger and the run directory off disk,
            // so a slow-but-healthy holder is normal, and stealing its lock puts
            // two processes inside the gate — the exact thing this prevents.
            // Age only breaks a lock we cannot check: another host, or a pid
            // that is gone.
            lastHolder.host === hostname()
            ? !isAlive(lastHolder.pid)
            : Date.now() - lastHolder.at > staleMs;

      if (abandoned) {
        // Break it and retry. Racing to break is safe: whoever wins the
        // subsequent 'wx' create holds the lock, and the loser simply waits.
        await rm(this.path, { force: true });
        continue;
      }

      if (Date.now() >= deadline) throw new LockTimeoutError(this.path, lastHolder);
      await sleep(waitMs);
      waitMs = Math.min(waitMs * 2, 250);
    }
  }

  /**
   * How long the lock file has existed, by mtime. `Infinity` when it is gone,
   * which makes a vanished file immediately "old enough" to break — the retry
   * then simply creates it.
   */
  private async ageMs(): Promise<number> {
    try {
      const s = await stat(this.path);
      return Math.max(0, Date.now() - s.mtimeMs);
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  private async readHolder(): Promise<LockHolder | null> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const h = parsed as Partial<LockHolder>;
      if (typeof h.pid !== 'number' || typeof h.at !== 'number' || typeof h.host !== 'string') {
        return null; // unparseable: treat as abandoned rather than immortal
      }
      return {
        pid: h.pid,
        host: h.host,
        at: h.at,
        ...(typeof h.token === 'string' ? { token: h.token } : {}),
      };
    } catch {
      return null;
    }
  }

  /**
   * Release only what we still hold.
   *
   * Compare-then-delete, never delete: if our lock was broken while we were
   * inside the critical section, the path now belongs to somebody else and
   * removing it would admit a third process alongside them.
   */
  private async release(): Promise<void> {
    const mine = this.token;
    this.token = null;
    if (!mine) return;
    const holder = await this.readHolder();
    // A lock we cannot read is not provably ours, so leave it: the grace window
    // and staleness rules will recover it if it really is abandoned.
    if (holder?.token !== mine) return;
    await rm(this.path, { force: true }).catch(() => undefined);
  }
}
