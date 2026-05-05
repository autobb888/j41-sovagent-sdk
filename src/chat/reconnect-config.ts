/**
 * Shared Socket.IO reconnect configuration.
 *
 * Used by chat client, workspace client, and buyer workspace client so all
 * three back off the same way under network blips. Without jitter, fleets of
 * agents thunderbolt-reconnect at the same instant after a relay restart.
 *
 * Socket.IO multiplies the base delay by 2^attempt (capped at delayMax) and
 * applies ±randomizationFactor jitter. With these defaults a client retries:
 *   ~0.5s → ~1.5s → ~3s → ~6s → ~12s → 30s (cap) → 30s …
 * over up to `attempts` tries.
 */
export const RECONNECT_CONFIG = {
  reconnection: true,
  reconnectionDelay: 1000,        // start at ~1s (with jitter, 0.5-1.5s)
  reconnectionDelayMax: 30_000,   // cap exponential growth at 30s
  randomizationFactor: 0.5,       // ±50% jitter to spread reconnect bursts
  reconnectionAttempts: 10,
} as const;

/**
 * Wait with exponential backoff + jitter, used between cycle-level retry
 * (after Socket.IO has exhausted its attempts and we want to fetch a fresh
 * token and try again).
 *
 *   cycle 1 → ~2s   (1000 × 2^1 + 0..1000 jitter)
 *   cycle 2 → ~4s   (1000 × 2^2 + 0..1000 jitter)
 *   cycle 3 → ~8s   (1000 × 2^3 + 0..1000 jitter)
 *
 * Capped at 60s so even a long restart eventually retries.
 */
export function cycleBackoffDelay(cycle: number): number {
  const base = Math.min(60_000, 1000 * Math.pow(2, Math.max(1, cycle)));
  const jitter = Math.floor(Math.random() * 1000);
  return base + jitter;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
