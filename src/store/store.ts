import { randomBytes } from 'node:crypto';
import { appendFile, chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KeyedMutex } from '../research/spend.js';
import { FileLock } from './file-lock.js';
import {
  JournalEventSchema,
  LedgerEntrySchema,
  RunRecordSchema,
  TERMINAL_STATES,
  type JournalEvent,
  type LedgerEntry,
  type RunRecord,
} from './types.js';

/**
 * Durable, dependency-free store.
 *
 * The single most important design decision in this server: **the job lifetime
 * and the MCP connection lifetime are not the same lifetime**. A 45-minute
 * research run outlives the client that started it, the agent session, and the
 * server process. So every state transition lands on disk before it is
 * reported, and a restarted server resumes polling from what it finds here.
 *
 * Layout under the store dir:
 *   runs/<id>.json          the run record (atomic write: tmp + rename)
 *   journal/<id>.jsonl      append-only progress events, replayable by cursor
 *   reports/<id>.md         the report markdown (kept out of the record so the
 *                           index stays cheap to scan)
 *   ledger.jsonl            append-only spend entries
 */

const RUN_ID_BYTES = 8;

export function newRunId(): string {
  return `dr_${randomBytes(RUN_ID_BYTES).toString('hex')}`;
}

/** Reject anything that could escape the store dir (CP §4 A03). */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function assertSafeId(id: string): void {
  if (!SAFE_ID.test(id)) throw new Error(`Invalid run id: ${id.slice(0, 32)}`);
}

export class Store {
  /** Serialises journal sequence allocation per run, within this process. */
  private readonly journalLock = new KeyedMutex();

  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private runPath(id: string): string {
    assertSafeId(id);
    return join(this.root, 'runs', `${id}.json`);
  }

  private journalPath(id: string): string {
    assertSafeId(id);
    return join(this.root, 'journal', `${id}.jsonl`);
  }

  reportPath(id: string): string {
    assertSafeId(id);
    return join(this.root, 'reports', `${id}.md`);
  }

  private get ledgerPath(): string {
    return join(this.root, 'ledger.jsonl');
  }

  /**
   * Cross-process lock guarding admission control for THIS store directory.
   *
   * Scoped to the store, not the process, because that is the resource being
   * contended: two servers on one store must serialise, two servers on separate
   * stores must not.
   */
  admissionLock(): FileLock {
    return new FileLock(join(this.root, '.admission.lock'));
  }

  async init(): Promise<void> {
    await Promise.all([
      // 0700/0600 throughout. The store holds research prompts, full reports
      // and a spend ledger; under a typical 022 umask every one of those was
      // world-readable on a shared machine.
      mkdir(join(this.root, 'runs'), { recursive: true, mode: 0o700 }),
      mkdir(join(this.root, 'journal'), { recursive: true, mode: 0o700 }),
      mkdir(join(this.root, 'reports'), { recursive: true, mode: 0o700 }),
    ]);
  }

  /**
   * Atomic write: a crash mid-write leaves the previous record intact rather
   * than a truncated JSON file that fails to parse on the next boot.
   */
  private async writeAtomic(path: string, contents: string): Promise<void> {
    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
    // Mode on create, then an explicit chmod: `mode` is masked by the umask, so
    // it alone does not guarantee 0600.
    await writeFile(tmp, contents, { encoding: 'utf8', mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => undefined);
    await rename(tmp, path);
  }

  async saveRun(record: RunRecord): Promise<void> {
    const validated = RunRecordSchema.parse(record);
    await this.writeAtomic(this.runPath(validated.id), JSON.stringify(validated, null, 2));
  }

  async getRun(id: string): Promise<RunRecord | null> {
    let raw: string;
    try {
      raw = await readFile(this.runPath(id), 'utf8');
    } catch {
      return null;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return null;
    }
    const parsed = RunRecordSchema.safeParse(parsedJson);
    return parsed.success ? parsed.data : null;
  }

  /**
   * List every run, newest first. Malformed records are skipped rather than
   * aborting the whole listing (skip-not-fatal, CP §1) — one hand-edited file
   * must not make the index unreadable.
   */
  async listRuns(): Promise<RunRecord[]> {
    let names: string[];
    try {
      names = await readdir(join(this.root, 'runs'));
    } catch {
      return [];
    }
    const out: RunRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const record = await this.getRun(name.slice(0, -'.json'.length));
      if (record) out.push(record);
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out;
  }

  /**
   * Count run files that exist but cannot be parsed.
   *
   * A malformed active run disappears from the concurrency count and from
   * dedupe, so corruption raises the concurrency cap and can buy a duplicate
   * report. The gate treats these as occupied slots rather than pretending
   * they are absent.
   */
  async unreadableRunCount(): Promise<number> {
    let names: string[];
    try {
      names = await readdir(join(this.root, 'runs'));
    } catch {
      return 0;
    }
    let bad = 0;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      if (!(await this.getRun(name.slice(0, -'.json'.length)))) bad += 1;
    }
    return bad;
  }

  async activeRuns(): Promise<RunRecord[]> {
    const all = await this.listRuns();
    return all.filter((r) => !TERMINAL_STATES.includes(r.state));
  }

  async deleteRun(id: string): Promise<boolean> {
    const existing = await this.getRun(id);
    if (!existing) return false;
    await Promise.all([
      rm(this.runPath(id), { force: true }),
      rm(this.journalPath(id), { force: true }),
      rm(this.reportPath(id), { force: true }),
    ]);
    return true;
  }

  private sessionPath(id: string): string {
    assertSafeId(id);
    return join(this.root, 'sessions', `${id}.json`);
  }

  /**
   * A local-loop session: its task list, its registry and its freeze state.
   *
   * Separate from the run record because it is written on every finding
   * submission while the record is not, and because a session that fails to
   * parse must not take a completed run's report down with it.
   */
  async saveSession(id: string, data: unknown): Promise<void> {
    await mkdir(join(this.root, 'sessions'), { recursive: true, mode: 0o700 });
    await this.writeAtomic(this.sessionPath(id), JSON.stringify(data, null, 2));
  }

  async readSession(id: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(this.sessionPath(id), 'utf8')) as unknown;
    } catch {
      return null;
    }
  }

  async saveReport(id: string, markdown: string): Promise<string> {
    const path = this.reportPath(id);
    await this.writeAtomic(path, markdown);
    return `reports/${id}.md`;
  }

  async readReport(id: string): Promise<string | null> {
    try {
      return await readFile(this.reportPath(id), 'utf8');
    } catch {
      return null;
    }
  }

  /** Append one journal event. Sequence numbers are per-run and monotonic. */
  /**
   * Append a journal event.
   *
   * Sequence allocation is read-then-append, so the poller and the stream
   * supervisor writing at the same moment could both read seq N and both write
   * N+1. `research_tail` pages by cursor, so a duplicate seq silently hides an
   * event from replay. Serialising per run makes allocation atomic in-process.
   */
  async appendJournal(id: string, kind: JournalEvent['kind'], message: string): Promise<JournalEvent> {
    return this.journalLock.run(id, async () => {
      const existing = await this.readJournal(id, -1);
      const seq = (existing.at(-1)?.seq ?? -1) + 1;
      const event: JournalEvent = {
        seq,
        at: new Date().toISOString(),
        kind,
        message: message.slice(0, 20_000),
      };
      await appendFile(this.journalPath(id), `${JSON.stringify(event)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      return event;
    });
  }

  /**
   * Replay journal events with `seq > sinceSeq`. Pass -1 for everything.
   * A malformed line is skipped so one bad append can't break the tail.
   */
  async readJournal(id: string, sinceSeq = -1): Promise<JournalEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.journalPath(id), 'utf8');
    } catch {
      return [];
    }
    const events: JournalEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        continue;
      }
      const parsed = JournalEventSchema.safeParse(json);
      if (parsed.success && parsed.data.seq > sinceSeq) events.push(parsed.data);
    }
    return events;
  }

  async appendLedger(entry: LedgerEntry): Promise<void> {
    const validated = LedgerEntrySchema.parse(entry);
    await appendFile(this.ledgerPath, `${JSON.stringify(validated)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  /**
   * Read the ledger, counting what could not be parsed.
   *
   * Skip-not-fatal is right for a listing and wrong for a spend gate. A
   * corrupted ledger line used to vanish from committed spend, so damaging the
   * file *raised* the ceiling: the one direction a budget must never fail.
   * Callers doing admission control use {@link readLedgerStrict}.
   */
  async readLedger(sinceIso?: string): Promise<LedgerEntry[]> {
    return (await this.readLedgerStrict(sinceIso)).entries;
  }

  async readLedgerStrict(
    sinceIso?: string,
  ): Promise<{ entries: LedgerEntry[]; unreadableLines: number }> {
    let raw: string;
    try {
      raw = await readFile(this.ledgerPath, 'utf8');
    } catch (e: unknown) {
      // A missing ledger is an empty ledger. Any other read failure is not:
      // treating "permission denied" as "nothing spent" unlocks the budget.
      if ((e as { code?: string }).code === 'ENOENT') return { entries: [], unreadableLines: 0 };
      throw new Error(
        `Cannot read the spend ledger at ${this.ledgerPath}: ${e instanceof Error ? e.message : String(e)}. ` +
          'Refusing to treat an unreadable ledger as zero spend.',
        { cause: e },
      );
    }
    const entries: LedgerEntry[] = [];
    let unreadableLines = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        unreadableLines += 1;
        continue;
      }
      const parsed = LedgerEntrySchema.safeParse(json);
      if (!parsed.success) {
        unreadableLines += 1;
        continue;
      }
      if (sinceIso && parsed.data.at < sinceIso) continue;
      entries.push(parsed.data);
    }
    return { entries, unreadableLines };
  }

  /**
   * Find a non-terminal-or-recent run with the same fingerprint, so a retry
   * storm, an agent restart, or three teammates asking the same question
   * collapse onto one paid job instead of three.
   */
  async findByFingerprint(fingerprint: string, ttlMinutes: number): Promise<RunRecord | null> {
    if (ttlMinutes <= 0) return null;
    const cutoff = new Date(Date.now() - ttlMinutes * 60_000).toISOString();
    const all = await this.listRuns();
    for (const run of all) {
      if (run.fingerprint !== fingerprint) continue;
      if (run.state === 'failed' || run.state === 'cancelled') continue;
      if (run.createdAt < cutoff) continue;
      return run;
    }
    return null;
  }
}
