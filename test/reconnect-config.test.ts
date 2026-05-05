import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { RECONNECT_CONFIG, cycleBackoffDelay, sleep } = require('../dist/chat/reconnect-config.js');

describe('reconnect-config', () => {
  describe('RECONNECT_CONFIG', () => {
    it('enables reconnection with sane defaults', () => {
      assert.strictEqual(RECONNECT_CONFIG.reconnection, true);
      assert.strictEqual(RECONNECT_CONFIG.reconnectionDelay, 1000);
      assert.strictEqual(RECONNECT_CONFIG.reconnectionDelayMax, 30_000);
      assert.strictEqual(RECONNECT_CONFIG.randomizationFactor, 0.5);
      assert.strictEqual(RECONNECT_CONFIG.reconnectionAttempts, 10);
    });

    it('caps reconnectionDelayMax at a value Socket.IO honors per-attempt', () => {
      // base * 2^attempt grows exponentially; cap at 30s prevents the 12th
      // retry from sleeping for half an hour.
      assert.ok(RECONNECT_CONFIG.reconnectionDelayMax >= RECONNECT_CONFIG.reconnectionDelay);
    });
  });

  describe('cycleBackoffDelay', () => {
    it('cycle 1 → between 2000 and 3000ms', () => {
      for (let i = 0; i < 50; i++) {
        const d = cycleBackoffDelay(1);
        assert.ok(d >= 2000 && d < 3000, `cycle 1 delay ${d} out of range`);
      }
    });

    it('cycle 2 → between 4000 and 5000ms', () => {
      for (let i = 0; i < 50; i++) {
        const d = cycleBackoffDelay(2);
        assert.ok(d >= 4000 && d < 5000, `cycle 2 delay ${d} out of range`);
      }
    });

    it('cycle 3 → between 8000 and 9000ms', () => {
      for (let i = 0; i < 50; i++) {
        const d = cycleBackoffDelay(3);
        assert.ok(d >= 8000 && d < 9000, `cycle 3 delay ${d} out of range`);
      }
    });

    it('cycle 0 floors to cycle 1 behavior (no zero-delay edge case)', () => {
      const d = cycleBackoffDelay(0);
      assert.ok(d >= 2000 && d < 3000, `cycle 0 delay ${d} should match cycle 1`);
    });

    it('high cycles cap at ~60s', () => {
      const d = cycleBackoffDelay(20);
      assert.ok(d >= 60_000 && d < 61_000, `cycle 20 delay ${d} should hit cap`);
    });

    it('jitter spreads delays so 100 calls produce >50 distinct values', () => {
      const values = new Set<number>();
      for (let i = 0; i < 100; i++) values.add(cycleBackoffDelay(2));
      assert.ok(values.size > 50, `only ${values.size} distinct values out of 100 — jitter too narrow`);
    });
  });

  describe('sleep', () => {
    it('resolves after roughly the requested ms', async () => {
      const start = Date.now();
      await sleep(50);
      const elapsed = Date.now() - start;
      assert.ok(elapsed >= 45 && elapsed < 200, `sleep elapsed ${elapsed}ms out of range`);
    });
  });
});
