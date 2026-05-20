// test/webhook-verify.test.ts
// Webhook verification: non-string guard + timestamp-bound replay window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  verifyWebhookSignature,
  verifyWebhookSignatureWithTimestamp,
  generateWebhookSecret,
} from '../src/webhook/verify.js';

const secret = 'test-secret';
const payload = JSON.stringify({ event: 'ping', n: 1 });
const hmac = (body: string) => createHmac('sha256', secret).update(body).digest('hex');

test('verifyWebhookSignature accepts a correct signature (with sha256= prefix)', () => {
  assert.equal(verifyWebhookSignature(payload, 'sha256=' + hmac(payload), secret), true);
});

test('verifyWebhookSignature rejects a wrong signature', () => {
  assert.equal(verifyWebhookSignature(payload, hmac('other'), secret), false);
});

test('verifyWebhookSignature returns false (no throw) on non-string signature', () => {
  // @ts-expect-error — exercising the runtime guard
  assert.equal(verifyWebhookSignature(payload, undefined, secret), false);
  // @ts-expect-error
  assert.equal(verifyWebhookSignature(payload, null, secret), false);
  assert.equal(verifyWebhookSignature(payload, '', secret), false);
});

test('verifyWebhookSignatureWithTimestamp accepts a fresh, correctly-signed payload', () => {
  const ts = 1_700_000_000;
  const sig = hmac(`${ts}.${payload}`);
  assert.equal(verifyWebhookSignatureWithTimestamp(payload, sig, secret, ts, { now: ts + 10 }), true);
});

test('verifyWebhookSignatureWithTimestamp rejects a stale timestamp (replay)', () => {
  const ts = 1_700_000_000;
  const sig = hmac(`${ts}.${payload}`);
  assert.equal(verifyWebhookSignatureWithTimestamp(payload, sig, secret, ts, { now: ts + 3600 }), false);
});

test('verifyWebhookSignatureWithTimestamp rejects a signature over a different timestamp', () => {
  const ts = 1_700_000_000;
  const sig = hmac(`${ts + 1}.${payload}`); // signed a different ts
  assert.equal(verifyWebhookSignatureWithTimestamp(payload, sig, secret, ts, { now: ts }), false);
});

test('generateWebhookSecret returns 64 hex chars', () => {
  assert.match(generateWebhookSecret(), /^[0-9a-f]{64}$/);
});
