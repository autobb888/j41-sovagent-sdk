/**
 * Bounded retry tracking for job-accept failures in `J41Agent.checkForJobs()`.
 *
 * Before this, a job whose `acceptJob` call failed (network blip, signer
 * rejection, a transient platform 5xx, …) was never added to `seenJobIds`
 * ("Don't mark as seen — allow retry"), so it was re-fetched and re-attempted
 * on EVERY poll (30s default) forever — no attempt cap, no backoff. The only
 * signal was an `error` event, which the agent's own self-installed listener
 * (see `agent.ts` constructor) reduces to a single `console.error` line when
 * the host app registers no listener of its own. This is the same unbounded-
 * retry shape as the dispatcher's inbox-accept bug (see
 * `j41-sovagent-dispatcher/src/inbox-deadletter.js`) — this module mirrors
 * that fix's pure-helper approach so the decision logic is unit-testable
 * without a client, a network, or a poll loop.
 *
 * This bounds retries: after `MAX_ACCEPT_ATTEMPTS` consecutive failures the
 * caller gives up — adds the job to `seenJobIds` (stops re-fetching it) and
 * emits a distinct terminal signal so an operator with an `error` listener
 * can tell "still retrying" apart from "abandoned, needs a human." It does
 * NOT recover the job; a genuinely broken accept (bad signer config, a job
 * the platform will never let this agent accept) is unrecoverable — the goal
 * is to fail loud once instead of spinning silently forever.
 *
 * The counter Map is caller-owned (a field on `J41Agent`, alongside
 * `seenJobIds`) and MUST be pruned by the caller whenever a job resolves
 * (accept succeeds, is rejected, or is abandoned) or leaves the pending set,
 * so it cannot grow unbounded — see `pruneAcceptFailures`.
 */

/** Matches the platform's other retry caps (review-verification worker, dispatcher inbox). */
export const MAX_ACCEPT_ATTEMPTS = 5;

export interface AcceptFailureResult {
  /** Total consecutive failed accept attempts recorded for this job, including this one. */
  attempts: number;
  /** True once `attempts` has reached `maxAttempts` — the caller must give up now. */
  giveUp: boolean;
}

/**
 * Record one failed accept attempt for `jobId` and decide whether the caller
 * should give up. Returns `{ attempts, giveUp }`.
 *
 * Does NOT mutate `seenJobIds` or emit anything — purely a counter decision
 * so it's trivially unit-testable. The caller is responsible for adding the
 * job to `seenJobIds` and emitting a terminal signal when `giveUp` is true.
 */
export function recordAcceptFailure(
  failures: Map<string, number>,
  jobId: string,
  maxAttempts: number = MAX_ACCEPT_ATTEMPTS,
): AcceptFailureResult {
  const attempts = (failures.get(jobId) ?? 0) + 1;
  const giveUp = attempts >= maxAttempts;
  failures.set(jobId, attempts);
  return { attempts, giveUp };
}

/**
 * Clear a job's failure counter. Call on successful accept (a later, unlikely
 * reused id starts fresh) and whenever a job is added to `seenJobIds` (give
 * up, reject) so the counter map doesn't retain an entry for a job that will
 * never be retried again.
 */
export function clearAcceptFailure(failures: Map<string, number>, jobId: string): void {
  failures.delete(jobId);
}

/**
 * Drop failure counters for jobs no longer present in the current poll's
 * pending set (accepted by a race, expired, cancelled, etc. — the platform's
 * `getMyJobs` response is the authoritative pending set for this call), so
 * the map cannot grow unbounded across many distinct jobs over the agent's
 * lifetime. Returns the count pruned.
 */
export function pruneAcceptFailures(failures: Map<string, number>, stillPendingIds: Set<string>): number {
  let pruned = 0;
  for (const id of [...failures.keys()]) {
    if (!stillPendingIds.has(id)) {
      failures.delete(id);
      pruned++;
    }
  }
  return pruned;
}
