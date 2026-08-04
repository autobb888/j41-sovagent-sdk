import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
const require = createRequire(import.meta.url);

const { J41Agent } = require('../dist/agent.js');

/**
 * A job container runs in BROKER mode: it holds no WIF by design — that is the
 * point of the host-side signing broker. `acceptReview` builds and signs an
 * identity transaction locally, so when the chat client auto-accepted an
 * incoming review it could only ever throw:
 *
 *   [J41] Unhandled error: Cannot accept review <id>: WIF key and i-address required
 *
 * ...twice per review, live. The host dispatcher's inbox sweep owns that write;
 * leaving the item `pending` is precisely what lets the host collect it, exactly
 * as the on-chain identity update already defers.
 */
describe('broker mode defers review accepts to the host', () => {
  it('usesRemoteSigner distinguishes broker mode from a local-WIF agent', () => {
    const broker = new J41Agent({
      apiUrl: 'https://example.invalid',
      signer: { signMessage: async () => 'sig' },
      identityName: 'a.agentplatform@',
      iAddress: 'iXXXX',
    });
    const local = new J41Agent({
      apiUrl: 'https://example.invalid',
      wif: 'Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      identityName: 'a.agentplatform@',
      iAddress: 'iXXXX',
    });
    assert.strictEqual(broker.usesRemoteSigner, true);
    assert.strictEqual(local.usesRemoteSigner, false);
  });

  it('acceptReview still refuses without a WIF (the guard stays)', async () => {
    // The fix is that we do not CALL this in broker mode — not that the guard
    // was weakened. Signing an identity tx without a key must remain impossible.
    const broker = new J41Agent({
      apiUrl: 'https://example.invalid',
      signer: { signMessage: async () => 'sig' },
      identityName: 'a.agentplatform@',
      iAddress: 'iXXXX',
    });
    await assert.rejects(
      () => broker.acceptReview('inbox-1'),
      /WIF key and i-address required/,
    );
  });

  it('the review handler early-returns on usesRemoteSigner before accepting', () => {
    // Structural: the handler is wired inside connectChat and needs a live chat
    // client to invoke, so assert the guard exists ahead of the accept call.
    // Falsifiable — removing the guard fails this.
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src', 'agent.ts'), 'utf8',
    );
    const handler = src.slice(
      src.indexOf('onReviewReceived'),
      src.indexOf('await this.chatClient.connect()'),
    );
    assert.ok(handler.length > 0, 'could not locate the review handler');
    const guardAt = handler.indexOf('this.usesRemoteSigner');
    const acceptAt = handler.indexOf('this.acceptReview(');
    assert.ok(guardAt !== -1, 'handler must check usesRemoteSigner');
    assert.ok(acceptAt !== -1, 'handler must still accept in local-WIF mode');
    assert.ok(guardAt < acceptAt, 'the broker-mode guard must come BEFORE the accept call');
  });
});
