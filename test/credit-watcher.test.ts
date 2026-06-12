import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { CreditWatcher } from '../src/buyer/credit-watcher.js';
import type {
  CreditWatcherDeps,
  CreditWatcherPolicy,
  TopUpResult,
} from '../src/buyer/credit-watcher.js';
import type { RemoteSigner, BrokerSignRequest, BrokerSignResponse } from '../src/identity/remote-signer.js';

// ------------------------------------------------------------------
// Fakes — fully deterministic, no chain / daemon / network.
// ------------------------------------------------------------------

/** Records every signMessage call so we can assert custody routes through the broker. */
function makeFakeSigner(): RemoteSigner & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    async signMessage(message: string): Promise<string> {
      messages.push(message);
      return `sig(${message.length})`;
    },
    async signBrokered(_req: BrokerSignRequest): Promise<BrokerSignResponse> {
      throw new Error('signBrokered not used by the credit watcher');
    },
  };
}

interface SendCall { to: string; amount: number; }
interface ReportCall { txid: string; amount: number | string; nonce: string; signature: string; message: string; }

function makeDeps(overrides: Partial<CreditWatcherDeps> = {}): {
  deps: CreditWatcherDeps;
  signer: RemoteSigner & { messages: string[] };
  sends: SendCall[];
  reports: ReportCall[];
  setNow: (ms: number) => void;
} {
  const signer = makeFakeSigner();
  const sends: SendCall[] = [];
  const reports: ReportCall[] = [];
  let nowMs = 1_000_000_000_000; // fixed wall clock

  const deps: CreditWatcherDeps = {
    signer,
    async sendVrsc(to: string, amount: number) {
      sends.push({ to, amount });
      return { txid: `txid-${sends.length}` };
    },
    async reportDeposit(report) {
      reports.push({
        txid: report.txid,
        amount: report.amount,
        nonce: report.nonce,
        signature: report.signature,
        message: report.message,
      });
      return { accepted: true, credited: String(report.amount) };
    },
    now: () => nowMs,
    randomNonce: () => 'nonce-fixed',
    ...overrides,
  };
  return { deps, signer, sends, reports, setNow: (ms) => { nowMs = ms; } };
}

const SELLER = {
  sellerVerusId: 'bob.sovcompute@',
  buyerVerusId: 'alice.sovagent@',
  payAddress: 'RsellerPayAddr0000000000000000000',
};

const POLICY: CreditWatcherPolicy = {
  threshold: 1.0,
  topUpAmount: 10.0,
  dailyCapVrsc: 30.0, // exactly 3 top-ups of 10
  minIntervalSec: 60,
};

function makeWatcher(opts: { policy?: Partial<CreditWatcherPolicy>; deps?: Partial<CreditWatcherDeps> } = {}) {
  const built = makeDeps(opts.deps);
  const watcher = new CreditWatcher({
    seller: SELLER,
    policy: { ...POLICY, ...opts.policy },
    deps: built.deps,
  });
  return { watcher, ...built };
}

describe('CreditWatcher', () => {
  describe('threshold detection (header path)', () => {
    it('tops up when remaining < threshold', async () => {
      const { watcher, sends, reports, signer } = makeWatcher();
      const result = await watcher.observeRemaining(0.5);

      assert.strictEqual(result.action, 'topped-up');
      assert.strictEqual(sends.length, 1);
      assert.strictEqual(sends[0].to, SELLER.payAddress);
      assert.strictEqual(sends[0].amount, 10.0);
      // deposit report posted and broker-signed
      assert.strictEqual(reports.length, 1);
      assert.strictEqual(reports[0].txid, 'txid-1');
      assert.strictEqual(reports[0].amount, 10.0);
      // custody: the deposit-report message was signed via the broker signer
      assert.strictEqual(signer.messages.length, 1);
      assert.match(signer.messages[0], /^J41-DEPOSIT-REPORT\|/);
    });

    it('does NOT top up when remaining >= threshold', async () => {
      const { watcher, sends, reports } = makeWatcher();
      const result = await watcher.observeRemaining(5.0);
      assert.strictEqual(result.action, 'above-threshold');
      assert.strictEqual(sends.length, 0);
      assert.strictEqual(reports.length, 0);
    });

    it('does NOT top up exactly at the threshold (strict <)', async () => {
      const { watcher, sends } = makeWatcher();
      const result = await watcher.observeRemaining(1.0);
      assert.strictEqual(result.action, 'above-threshold');
      assert.strictEqual(sends.length, 0);
    });

    it('ignores non-finite / missing header values without spending', async () => {
      const { watcher, sends } = makeWatcher();
      const r1 = await watcher.observeRemaining(NaN);
      const r2 = await watcher.observeRemaining(undefined as unknown as number);
      assert.strictEqual(r1.action, 'no-op');
      assert.strictEqual(r2.action, 'no-op');
      assert.strictEqual(sends.length, 0);
    });
  });

  describe('webhook path (proxy.credit_low)', () => {
    it('tops up on a credit_low event below threshold', async () => {
      const { watcher, sends } = makeWatcher();
      const result = await watcher.onCreditLow({
        sellerVerusId: SELLER.sellerVerusId,
        buyerVerusId: SELLER.buyerVerusId,
        balance: '0.83',
        threshold: '1.0',
        suggestedTopup: '10.0',
        payAddress: SELLER.payAddress,
        observedAt: 1749740000,
      });
      assert.strictEqual(result.action, 'topped-up');
      assert.strictEqual(sends.length, 1);
    });

    it('ignores a credit_low event for a different seller', async () => {
      const { watcher, sends } = makeWatcher();
      const result = await watcher.onCreditLow({
        sellerVerusId: 'someone.else@',
        buyerVerusId: SELLER.buyerVerusId,
        balance: '0.10',
        threshold: '1.0',
        suggestedTopup: '10.0',
        payAddress: 'Rother',
        observedAt: 1749740000,
      });
      assert.strictEqual(result.action, 'no-op');
      assert.strictEqual(sends.length, 0);
    });
  });

  describe('idempotency (minInterval + pending guard)', () => {
    it('header + webhook for the same crossing yields exactly ONE top-up', async () => {
      const { watcher, sends } = makeWatcher();
      // Same crossing: a header read AND the webhook both fire below threshold.
      const r1 = await watcher.observeRemaining(0.5);
      const r2 = await watcher.onCreditLow({
        sellerVerusId: SELLER.sellerVerusId,
        buyerVerusId: SELLER.buyerVerusId,
        balance: '0.5',
        threshold: '1.0',
        suggestedTopup: '10.0',
        payAddress: SELLER.payAddress,
        observedAt: 1749740001,
      });
      assert.strictEqual(r1.action, 'topped-up');
      assert.strictEqual(r2.action, 'rate-limited');
      assert.strictEqual(sends.length, 1, 'burst of low signals must trigger exactly one top-up');
    });

    it('respects minIntervalSec: a second low signal within the window is skipped', async () => {
      const { watcher, sends, setNow } = makeWatcher();
      await watcher.observeRemaining(0.5); // t=0
      setNow(1_000_000_000_000 + 30_000); // +30s, still inside 60s window
      const r2 = await watcher.observeRemaining(0.4);
      assert.strictEqual(r2.action, 'rate-limited');
      assert.strictEqual(sends.length, 1);
    });

    it('allows another top-up once minIntervalSec has elapsed', async () => {
      const { watcher, sends, setNow } = makeWatcher();
      await watcher.observeRemaining(0.5); // t=0
      setNow(1_000_000_000_000 + 61_000); // +61s, past the window
      const r2 = await watcher.observeRemaining(0.4);
      assert.strictEqual(r2.action, 'topped-up');
      assert.strictEqual(sends.length, 2);
    });

    it('concurrent low signals (no await between) still produce one top-up (pending guard)', async () => {
      // Make the send slow so both calls overlap before the first resolves.
      let release!: () => void;
      const gate = new Promise<void>((res) => { release = res; });
      const built = makeDeps();
      const slowSends: SendCall[] = [];
      built.deps.sendVrsc = async (to: string, amount: number) => {
        slowSends.push({ to, amount });
        await gate;
        return { txid: 'txid-slow' };
      };
      const watcher = new CreditWatcher({ seller: SELLER, policy: POLICY, deps: built.deps });

      const p1 = watcher.observeRemaining(0.5);
      const p2 = watcher.observeRemaining(0.4);
      release();
      const [r1, r2] = await Promise.all([p1, p2]);

      const actions = [r1.action, r2.action].sort();
      assert.deepStrictEqual(actions, ['rate-limited', 'topped-up'].sort());
      assert.strictEqual(slowSends.length, 1, 'pending guard must prevent a concurrent double-spend');
    });
  });

  describe('hard spend cap (dailyCapVrsc)', () => {
    it('stops at the cap and fires an alert instead of spending past it', async () => {
      const alerts: unknown[] = [];
      const { watcher, sends, setNow } = makeWatcher({ deps: { onAlert: (a) => { alerts.push(a); } } });
      const base = 1_000_000_000_000;
      // cap=30, topUp=10 → exactly 3 allowed, 4th must be blocked.
      for (let i = 0; i < 4; i++) {
        setNow(base + i * 61_000); // each past the minInterval window
        await watcher.observeRemaining(0.1);
      }
      assert.strictEqual(sends.length, 3, 'must not exceed dailyCap (3 × 10 = 30)');
      assert.ok(alerts.length >= 1, 'cap breach must surface an alert');
      const capAlert = alerts.find((a: any) => a.type === 'daily-cap-reached');
      assert.ok(capAlert, 'an alert with type "daily-cap-reached" must fire');
    });

    it('never tops up when a single top-up would exceed the remaining cap room', async () => {
      // cap=15, topUp=10 → first ok (spent 10), second would make 20 > 15 → blocked.
      const alerts: any[] = [];
      const { watcher, sends, setNow } = makeWatcher({
        policy: { dailyCapVrsc: 15 },
        deps: { onAlert: (a) => alerts.push(a) },
      });
      const base = 1_000_000_000_000;
      await watcher.observeRemaining(0.1);
      setNow(base + 61_000);
      const r2 = await watcher.observeRemaining(0.1);
      assert.strictEqual(sends.length, 1);
      assert.strictEqual(r2.action, 'cap-reached');
      assert.ok(alerts.some((a) => a.type === 'daily-cap-reached'));
    });

    it('cap is per rolling 24h: spend resets after the window', async () => {
      const { watcher, sends, setNow } = makeWatcher({ policy: { dailyCapVrsc: 10 } });
      const base = 1_000_000_000_000;
      await watcher.observeRemaining(0.1); // spends 10, at cap
      setNow(base + 61_000);
      const blocked = await watcher.observeRemaining(0.1);
      assert.strictEqual(blocked.action, 'cap-reached');
      // advance past 24h — cap window rolls over
      setNow(base + 24 * 3600 * 1000 + 1000);
      const ok = await watcher.observeRemaining(0.1);
      assert.strictEqual(ok.action, 'topped-up');
      assert.strictEqual(sends.length, 2);
    });
  });

  describe('observability', () => {
    it('exposes spentToday and lastTopUpAt for the caller', async () => {
      const { watcher } = makeWatcher();
      await watcher.observeRemaining(0.5);
      const status = watcher.status();
      assert.strictEqual(status.spentToday, 10);
      assert.ok(status.lastTopUpAt > 0);
      assert.strictEqual(status.pending, false);
    });
  });

  describe('failure handling', () => {
    it('a failed send does not leave the pending guard stuck and surfaces an alert', async () => {
      const alerts: any[] = [];
      const built = makeDeps({
        async sendVrsc() { throw new Error('chain unreachable'); },
        onAlert: (a) => alerts.push(a),
      });
      const watcher = new CreditWatcher({ seller: SELLER, policy: POLICY, deps: built.deps });
      const r1 = await watcher.observeRemaining(0.5);
      assert.strictEqual(r1.action, 'error');
      assert.ok(alerts.some((a) => a.type === 'topup-failed'));
      assert.strictEqual(built.sends.length, 0);
      assert.strictEqual(watcher.status().pending, false, 'guard must clear after failure');
      // a failed attempt must not count against the daily cap
      assert.strictEqual(watcher.status().spentToday, 0);
    });
  });
});
