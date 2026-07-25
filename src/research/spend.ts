/**
 * The spend gate's critical section.
 *
 * Every check in `Runner.start` is an `await` on a disk read, and nothing
 * serialised them. Two concurrent `research_start` calls both read
 * `activeRuns()` and `budget()` before either writes its ledger entry, so both
 * see headroom and both proceed. Agents make parallel tool calls routinely, so
 * this is not a theoretical race: N concurrent calls could exceed both the
 * concurrency cap and the budget by N-1 runs, which at $7 a run is real money.
 *
 * The fix is to make check-and-reserve one atomic step. This is a single
 * process, so an in-process mutex is sufficient and correct.
 *
 * **Known limit, stated rather than hidden, and larger than it first looks:**
 * two server processes sharing one store directory each hold their own mutex
 * and can still race. This is not hypothetical or HTTP-only. Two MCP clients
 * (say Claude Code and Cursor) both configured with Dossier are two processes
 * on the default store, and each can observe $95 of a $100 ceiling and admit
 * another $7 run. An external review was right that "one process per client"
 * makes multiple writers *more* likely, not less.
 *
 * Closing it properly means cross-process serialisation. The cheapest correct
 * option is an exclusive per-store writer lease if multiple writers are
 * declared unsupported; the more honest one is moving admission control to
 * SQLite with `BEGIN IMMEDIATE`, which also fixes the read-modify-write races
 * in refresh, cancellation and journal writes. Neither is a code comment's
 * decision, so this stays documented rather than quietly assumed away, and the
 * reservation remains the one
 * place that needs to change.
 */

/**
 * Serialises async work onto a queue. Each task runs to completion before the
 * next starts, so a check followed by a write cannot interleave with another
 * caller's check.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  /** Run `task` exclusively. Rejections propagate and do not wedge the queue. */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    // The queue must advance whether the task resolved or threw, otherwise one
    // failed reservation blocks every later one forever.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * What a run reserves against the budget.
 *
 * The gate reserves the **worst case**, not the midpoint. A `max` run is
 * $3-7; reserving the $5 midpoint means a run that actually costs $7
 * systematically overshoots, and a guardrail that overshoots is not a
 * guardrail. Reserving the high end can only make the server refuse slightly
 * early, which is the safe direction for a ceiling.
 */
export interface Reservation {
  /** Charged against the ceiling. The high end of the published band. */
  readonly reservedUsd: number;
  /** The band's midpoint, for reporting what a run will probably cost. */
  readonly likelyUsd: number;
}

/**
 * A mutex per key, so unrelated runs never queue behind each other.
 *
 * The single spend lock is right for the budget, which is global. It is wrong
 * for per-run lifecycle transitions: approving run A must not wait on run B,
 * but two approvals of run A must not interleave. Read-then-paid-call-then-write
 * on the same run is how one plan approval becomes two paid continuations, with
 * the loser orphaned and still billing.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve();
    const result = prior.then(task, task);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, settled);
    // Drop the entry once nothing is queued behind it, so a long-lived server
    // does not accumulate one promise per run it has ever handled.
    void settled.then(() => {
      if (this.tails.get(key) === settled) this.tails.delete(key);
    });
    return result;
  }
}
