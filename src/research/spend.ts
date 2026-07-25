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
 * **Known limit, stated rather than hidden:** two server processes sharing one
 * store directory would each hold their own mutex and could still race. The
 * store is per-user and the server is normally one process per client, so this
 * is not worth a lock file today; if it ever is, the reservation is the one
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
