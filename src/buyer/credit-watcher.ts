/**
 * CreditWatcher — buyer-side auto-top-up for the sovcompute prepaid proxy.
 *
 * A hirer/brainbox runs this so it refills its prepaid compute credit from its
 * OWN wallet *before* it ever hits a `402`, without surrendering custody. It
 * automates exactly what a buyer does manually today: send VRSC to the seller's
 * pay address, then submit a broker-signed deposit report so the dispatcher
 * credits the meter (spec `2026-06-12-sovcompute-credit-low-autotopup.md` §3).
 *
 * ## Two detection paths (spec §1)
 * - **header-driven (primary):** the client is already making proxied requests
 *   and reading `X-J41-Credit-Remaining` off each response. After each call it
 *   calls {@link CreditWatcher.observeRemaining} with that value. No webhook
 *   infra required — this is the brainbox / headless path.
 * - **webhook-driven (idle):** the buyer's registered webhook receives a
 *   `proxy.credit_low` event (spec §2b). The client forwards its `data` payload
 *   to {@link CreditWatcher.onCreditLow}. Covers the idle buyer not currently
 *   calling.
 *
 * Both paths funnel into the SAME debounced, capped, idempotent top-up decision,
 * so a burst of low signals (header + webhook for one crossing) tops up ONCE.
 *
 * ## Custody / fail-closed (spec §4)
 * - **Broker-signed, no raw WIF:** the watcher never holds a key. The on-chain
 *   send is delegated to an injected {@link CreditWatcherDeps.sendVrsc} (which a
 *   host-side broker fulfils), and the deposit-report message is signed through
 *   the injected {@link RemoteSigner} (`signMessage`) — the same broker the rest
 *   of the SDK uses.
 * - **Hard spend cap:** `dailyCapVrsc` is a ceiling the watcher can NEVER
 *   exceed. A runaway/abusive seller draining credit cannot trigger unbounded
 *   auto-spend. At the cap it stops and surfaces an alert.
 * - **Idempotent:** `minIntervalSec` + an in-flight pending guard collapse a
 *   burst of low signals to a single top-up.
 *
 * Everything that touches the chain or network is injected, so the decision
 * logic is unit-testable with fakes — no live daemon required.
 */

import type { RemoteSigner } from '../identity/remote-signer.js';
import { buildDepositReportMessage } from '../signing/messages.js';

/** Seller / session identity the watcher tops up against. */
export interface CreditWatcherSeller {
  /** Seller agent's VerusID (the sovcompute provider), e.g. `bob.sovcompute@`. */
  sellerVerusId: string;
  /** This buyer's VerusID claiming the deposit, e.g. `alice.sovagent@`. */
  buyerVerusId: string;
  /**
   * Seller's on-chain deposit address (R- or i-address) top-ups are sent to.
   * Convenience copy of the on-chain pay address; the credit_low webhook also
   * carries it. If a webhook reports a different address for this seller it is
   * IGNORED — the watcher only ever sends to its configured `payAddress` so a
   * forged/MITM'd webhook cannot redirect funds.
   */
  payAddress: string;
}

/** Buyer-set top-up policy (spec §3 SDK watcher contract). */
export interface CreditWatcherPolicy {
  /** Top up when observed remaining credit dips strictly below this (VRSC). */
  threshold: number;
  /** How much VRSC to send per top-up. */
  topUpAmount: number;
  /**
   * HARD daily ceiling (VRSC) on auto-spend. The watcher NEVER spends past this
   * in a rolling 24h window; a top-up that would breach it is refused and an
   * alert fires instead.
   */
  dailyCapVrsc: number;
  /** Minimum seconds between top-ups — debounces a burst into one. */
  minIntervalSec: number;
}

/** The `proxy.credit_low` webhook `data` payload (spec §2b). */
export interface CreditLowEvent {
  sellerVerusId: string;
  buyerVerusId: string;
  balance: string | number;
  threshold: string | number;
  suggestedTopup: string | number;
  payAddress: string;
  observedAt: number;
}

/** Arguments to {@link CreditWatcherDeps.reportDeposit}. */
export interface DepositReport {
  buyerVerusId: string;
  sellerVerusId: string;
  txid: string;
  amount: number | string;
  nonce: string;
  timestamp: number;
  /** base64 Verus message signature over {@link message}, produced by the broker. */
  signature: string;
  /** The exact canonical `J41-DEPOSIT-REPORT|...` string that was signed. */
  message: string;
}

/** Alert surfaced to the caller on a cap breach or top-up failure. */
export type CreditWatcherAlert =
  | {
      type: 'daily-cap-reached';
      sellerVerusId: string;
      spentToday: number;
      dailyCapVrsc: number;
      attemptedAmount: number;
    }
  | {
      type: 'topup-failed';
      sellerVerusId: string;
      stage: 'send' | 'report';
      error: string;
    };

/**
 * Injected side-effect dependencies. Keeping the on-chain send + the
 * deposit-report POST behind interfaces is what makes the watcher testable
 * without a chain/daemon AND what keeps the raw WIF out of this process.
 */
export interface CreditWatcherDeps {
  /**
   * The host-side signing broker. Only `signMessage` is used (the deposit
   * report is an arbitrary J41-protocol message, not a broker-gated job
   * action). The watcher never sees a WIF.
   */
  signer: RemoteSigner;
  /**
   * Broadcast a broker-signed payment of `amount` VRSC to `to`, returning the
   * txid. In production this routes through the host-side broker (which holds
   * the key); in tests it's a fake. MUST NOT be fulfilled with a key held by
   * the watcher process.
   */
  sendVrsc: (to: string, amount: number) => Promise<{ txid: string }>;
  /**
   * POST the broker-signed deposit report to `{dispatcherUrl}/j41/deposit/report`
   * (spec §2c). Abstracted so the watcher stays transport-agnostic and unit
   * testable.
   */
  reportDeposit: (report: DepositReport) => Promise<{ accepted: boolean; credited?: string }>;
  /** Surface cap breaches / failures to the caller (UI, log, pager). Optional. */
  onAlert?: (alert: CreditWatcherAlert) => void;
  /** Clock injection (unix MILLIseconds). Defaults to `Date.now`. */
  now?: () => number;
  /** Single-use nonce generator for the deposit report. Defaults to a random hex. */
  randomNonce?: () => string;
}

export type TopUpAction =
  /** A top-up was sent and the deposit report submitted. */
  | 'topped-up'
  /** Observed value is at/above threshold — nothing to do. */
  | 'above-threshold'
  /** Debounced: inside minInterval or an in-flight top-up is pending. */
  | 'rate-limited'
  /** Refused: a top-up would breach the daily cap (an alert fired). */
  | 'cap-reached'
  /** The send or report failed (an alert fired); cap untouched. */
  | 'error'
  /** Signal ignored (wrong seller, non-finite value). */
  | 'no-op';

export interface TopUpResult {
  action: TopUpAction;
  /** Present when `action === 'topped-up'`. */
  txid?: string;
  amount?: number;
  /** Present when `action === 'error'`. */
  error?: string;
}

export interface CreditWatcherStatus {
  /** VRSC auto-spent in the current rolling 24h window. */
  spentToday: number;
  /** unix MILLIseconds of the last successful top-up (0 if none). */
  lastTopUpAt: number;
  /** True while a top-up is in flight (the pending guard is held). */
  pending: boolean;
}

export interface CreditWatcherConfig {
  seller: CreditWatcherSeller;
  policy: CreditWatcherPolicy;
  deps: CreditWatcherDeps;
}

const DAY_MS = 24 * 3600 * 1000;

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number.parseFloat(v);
  return NaN;
}

function defaultNonce(): string {
  // Avoid a hard dependency on node:crypto at module load for slim consumers.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { randomBytes } = require('crypto') as typeof import('crypto');
  return randomBytes(16).toString('hex');
}

/**
 * Buyer-side auto-top-up watcher. Construct one per (buyer, seller) pair and
 * feed it credit signals from either detection path.
 */
export class CreditWatcher {
  private readonly seller: CreditWatcherSeller;
  private readonly policy: CreditWatcherPolicy;
  private readonly deps: Required<Pick<CreditWatcherDeps, 'now' | 'randomNonce'>> & CreditWatcherDeps;

  /** In-flight guard: collapses concurrent low signals into one top-up. */
  private pending = false;
  /** unix ms of the last successful top-up (debounce anchor). */
  private lastTopUpAt = 0;
  /** Rolling-window ledger of (timestampMs, amount) successful top-ups. */
  private spends: Array<{ at: number; amount: number }> = [];

  constructor(config: CreditWatcherConfig) {
    this.seller = config.seller;
    this.policy = config.policy;
    this.deps = {
      ...config.deps,
      now: config.deps.now ?? (() => Date.now()),
      randomNonce: config.deps.randomNonce ?? defaultNonce,
    };
  }

  // ----------------------------------------------------------------
  // Detection path (B): header-driven
  // ----------------------------------------------------------------

  /**
   * Feed the `X-J41-Credit-Remaining` value read off a proxied response. Call
   * this after every proxied request (e.g. with `callProxied(...).creditRemaining`).
   * Returns the decision taken so the caller can log/observe it.
   */
  async observeRemaining(remaining: number): Promise<TopUpResult> {
    if (!Number.isFinite(remaining)) return { action: 'no-op' };
    if (remaining >= this.policy.threshold) return { action: 'above-threshold' };
    return this.maybeTopUp();
  }

  /**
   * A convenience wrapper to drop into a proxied-call pipeline: pass the result
   * of {@link import('../client/index.js').J41Client.callProxied} (or anything
   * exposing `creditRemaining`) and the watcher observes the header for you.
   * Returns the same object so it can be used transparently in a chain.
   */
  async afterProxiedResponse<T extends { creditRemaining?: number }>(response: T): Promise<T> {
    if (response && typeof response.creditRemaining === 'number') {
      await this.observeRemaining(response.creditRemaining);
    }
    return response;
  }

  // ----------------------------------------------------------------
  // Detection path (A): webhook-driven (proxy.credit_low)
  // ----------------------------------------------------------------

  /**
   * Handle a `proxy.credit_low` webhook payload (the event's `data` object,
   * spec §2b). Events for a different seller are ignored. The reported
   * `payAddress` is NOT trusted for routing — the watcher always sends to its
   * configured `seller.payAddress`.
   */
  async onCreditLow(event: CreditLowEvent): Promise<TopUpResult> {
    if (event.sellerVerusId !== this.seller.sellerVerusId) return { action: 'no-op' };
    const balance = toNumber(event.balance);
    if (!Number.isFinite(balance)) return { action: 'no-op' };
    if (balance >= this.policy.threshold) return { action: 'above-threshold' };
    return this.maybeTopUp();
  }

  // ----------------------------------------------------------------
  // Core decision — debounce + hard cap + broker-signed top-up
  // ----------------------------------------------------------------

  private async maybeTopUp(): Promise<TopUpResult> {
    const now = this.deps.now();

    // (1) pending guard — a concurrent in-flight top-up wins; everyone else is
    //     rate-limited. This is what makes a header+webhook burst exactly one.
    if (this.pending) return { action: 'rate-limited' };

    // (2) minInterval debounce.
    if (this.lastTopUpAt > 0 && now - this.lastTopUpAt < this.policy.minIntervalSec * 1000) {
      return { action: 'rate-limited' };
    }

    // (3) HARD daily cap — refuse if this top-up would breach the ceiling.
    const spentToday = this.spentInWindow(now);
    if (spentToday + this.policy.topUpAmount > this.policy.dailyCapVrsc) {
      this.emitAlert({
        type: 'daily-cap-reached',
        sellerVerusId: this.seller.sellerVerusId,
        spentToday,
        dailyCapVrsc: this.policy.dailyCapVrsc,
        attemptedAmount: this.policy.topUpAmount,
      });
      return { action: 'cap-reached' };
    }

    // Claim the guard BEFORE the first await so overlapping callers see it.
    this.pending = true;
    try {
      const amount = this.policy.topUpAmount;

      // (4) broker-signed on-chain send to the seller pay address.
      let txid: string;
      try {
        const sent = await this.deps.sendVrsc(this.seller.payAddress, amount);
        txid = sent.txid;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.emitAlert({ type: 'topup-failed', sellerVerusId: this.seller.sellerVerusId, stage: 'send', error: msg });
        return { action: 'error', error: msg };
      }

      // (5) broker-signed deposit report → dispatcher credits the meter.
      const timestamp = Math.floor(this.deps.now() / 1000);
      const nonce = this.deps.randomNonce();
      const message = buildDepositReportMessage({
        buyerVerusId: this.seller.buyerVerusId,
        sellerVerusId: this.seller.sellerVerusId,
        txid,
        amount,
        nonce,
        timestamp,
      });
      let signature: string;
      try {
        signature = await this.deps.signer.signMessage(message);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        this.emitAlert({ type: 'topup-failed', sellerVerusId: this.seller.sellerVerusId, stage: 'report', error: m });
        return { action: 'error', error: m };
      }

      try {
        await this.deps.reportDeposit({
          buyerVerusId: this.seller.buyerVerusId,
          sellerVerusId: this.seller.sellerVerusId,
          txid,
          amount,
          nonce,
          timestamp,
          signature,
          message,
        });
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        // Funds left the wallet but the report failed. Surface it; the
        // dispatcher's deposit-watcher / a manual re-report can still claim the
        // on-chain txid. We DO count the spend (the chain spend happened) and
        // arm the debounce so we don't immediately re-send on the next signal.
        this.recordSpend(amount, now);
        this.lastTopUpAt = now;
        this.emitAlert({ type: 'topup-failed', sellerVerusId: this.seller.sellerVerusId, stage: 'report', error: m });
        return { action: 'error', error: m };
      }

      // Success — record against the cap window + arm the debounce.
      this.recordSpend(amount, now);
      this.lastTopUpAt = now;
      return { action: 'topped-up', txid, amount };
    } finally {
      this.pending = false;
    }
  }

  // ----------------------------------------------------------------
  // Status / bookkeeping
  // ----------------------------------------------------------------

  /** Current spend/debounce state — for logging, dashboards, tests. */
  status(): CreditWatcherStatus {
    return {
      spentToday: this.spentInWindow(this.deps.now()),
      lastTopUpAt: this.lastTopUpAt,
      pending: this.pending,
    };
  }

  private spentInWindow(now: number): number {
    const cutoff = now - DAY_MS;
    let total = 0;
    for (const s of this.spends) if (s.at > cutoff) total += s.amount;
    return total;
  }

  private recordSpend(amount: number, at: number): void {
    // Prune the ledger as we go so it can't grow unbounded.
    const cutoff = at - DAY_MS;
    this.spends = this.spends.filter((s) => s.at > cutoff);
    this.spends.push({ at, amount });
  }

  private emitAlert(alert: CreditWatcherAlert): void {
    try {
      this.deps.onAlert?.(alert);
    } catch {
      /* a faulty alert sink must never break the watcher's fail-closed path */
    }
  }
}
