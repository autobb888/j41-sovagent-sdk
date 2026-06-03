/**
 * RemoteSigner integration tests — verify that a J41Agent constructed with a
 * `signer` (and no WIF) routes every signing path through that signer, and
 * that the agent passes the broker-returned signature + timestamp through
 * unchanged to the platform API.
 *
 * The dispatcher's host-side broker (`@junction41/dispatcher/sign-broker`)
 * implements `RemoteSigner` over a bind-mounted file channel. These tests use
 * an in-process recording mock that captures every call.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { J41Agent } = require('../dist/agent.js');
const { generateKeypair } = require('../dist/identity/keypair.js');
const { createLocalSigner } = require('../dist/identity/remote-signer.js');
const { signMessage: signMessageDirect, verifyMessage } = require('../dist/identity/signer.js');

interface RecordedCall {
  kind: 'signMessage' | 'signBrokered';
  arg: unknown;
}

/** A signer that records every call and returns deterministic synthetic
 *  signatures so tests can assert on what the agent forwarded to the API. */
function recordingSigner(opts?: {
  /** Optional underlying WIF — if set, the signer actually signs with it so
   *  the resulting signature is verifiable. Otherwise returns a synthetic
   *  placeholder. */
  wif?: string;
  network?: 'verus' | 'verustest';
}) {
  const calls: RecordedCall[] = [];
  const network = opts?.network ?? 'verustest';
  const signer = {
    calls,
    async signMessage(message: string): Promise<string> {
      calls.push({ kind: 'signMessage', arg: message });
      if (opts?.wif) return signMessageDirect(opts.wif, message, network);
      return `sig:msg:${message.length}`;
    },
    async signBrokered(req: any): Promise<any> {
      calls.push({ kind: 'signBrokered', arg: req });
      const timestamp = 1_700_000_000;
      // The real broker would reconstruct from authoritative job; here we
      // just synthesize a deterministic response for assertion.
      const message = `broker-built:${req.type}:${JSON.stringify(req)}`;
      const signature = opts?.wif
        ? signMessageDirect(opts.wif, message, network)
        : `sig:brok:${req.type}`;
      return { signature, timestamp, message };
    },
  };
  return signer;
}

describe('RemoteSigner — createLocalSigner', () => {
  it('signMessage produces a Verus signature that verifies against the WIF address', async () => {
    const kp = generateKeypair('verustest');
    const signer = createLocalSigner(kp.wif, 'verustest');
    const sig = await signer.signMessage('hello');
    assert.ok(sig.length > 0);
    assert.ok(verifyMessage('hello', kp.address, sig));
  });

  // Audit 2.5.1 L-SDK-auth-2: the deliver / dispute_respond synthetic-jobId
  // paths are gated behind J41_LOCAL_SIGNER_TEST_MODE=1 so production agents
  // can't silently fall through. Tests must set + clear it explicitly.
  it('signBrokered({type:"deliver"}) signs a deliver message bound to jobId + deliveryHash', async () => {
    process.env.J41_LOCAL_SIGNER_TEST_MODE = '1';
    try {
      const kp = generateKeypair('verustest');
      const signer = createLocalSigner(kp.wif, 'verustest');
      const deliveryHash = 'a'.repeat(64);
      const res = await signer.signBrokered({ type: 'deliver', jobId: 'job-hash-X', deliveryHash });
      assert.ok(res.signature.length > 0);
      assert.ok(res.timestamp > 0);
      assert.match(res.message, /J41-DELIVER\|Job:job-hash-X\|Delivery:a{64}/);
      assert.ok(verifyMessage(res.message, kp.address, res.signature));
    } finally {
      delete process.env.J41_LOCAL_SIGNER_TEST_MODE;
    }
  });

  it('signBrokered({type:"deliver"}) refuses outside test mode (L-SDK-auth-2)', async () => {
    const kp = generateKeypair('verustest');
    const signer = createLocalSigner(kp.wif, 'verustest');
    await assert.rejects(
      () => signer.signBrokered({ type: 'deliver', jobId: 'job-hash-X', deliveryHash: 'a'.repeat(64) }),
      /authoritative jobHash|J41_LOCAL_SIGNER_TEST_MODE/,
    );
  });

  it('signBrokered({type:"dispute_respond"}) signs a dispute-respond message', async () => {
    process.env.J41_LOCAL_SIGNER_TEST_MODE = '1';
    try {
      const kp = generateKeypair('verustest');
      const signer = createLocalSigner(kp.wif, 'verustest');
      const res = await signer.signBrokered({
        type: 'dispute_respond',
        jobId: 'a'.repeat(64),
        action: 'refund',
      });
      assert.match(res.message, /J41-DISPUTE-RESPOND\|/);
      assert.ok(verifyMessage(res.message, kp.address, res.signature));
    } finally {
      delete process.env.J41_LOCAL_SIGNER_TEST_MODE;
    }
  });

  it('signBrokered({type:"accept"}) refuses locally (no authoritative job record)', async () => {
    const kp = generateKeypair('verustest');
    const signer = createLocalSigner(kp.wif, 'verustest');
    await assert.rejects(
      () => signer.signBrokered({ type: 'accept', jobId: 'job-1' }),
      /cannot be served locally/,
    );
  });
});

describe('J41Agent — RemoteSigner integration', () => {
  it('constructor accepts signer-only (no WIF) and reports usesRemoteSigner=true', () => {
    const signer = recordingSigner();
    const agent = new J41Agent({
      apiUrl: 'https://api.example.com',
      signer,
      identityName: 'testagent.agentplatform@',
      iAddress: 'iTest',
    });
    assert.strictEqual(agent.usesRemoteSigner, true);
  });

  it('constructor without WIF or signer still constructs (degraded — must throw on first sign)', async () => {
    // Today's behavior: agent constructs even without credentials; signing
    // sites throw "WIF key required" on use. The new behavior keeps that
    // shape but the error message now mentions remote signer too.
    const agent = new J41Agent({ apiUrl: 'https://api.example.com' });
    assert.strictEqual(agent.usesRemoteSigner, false);
    // Trigger a signing path — auth challenge — and expect a clear error
    agent.client.getAuthChallenge = async () => ({
      challengeId: 'c1',
      challenge: 'opaque-challenge',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await assert.rejects(
      () => agent.authenticate(),
      /WIF key or remote signer required|Identity name required/,
    );
  });

  it('auth challenge signing routes through signer.signMessage', async () => {
    const signer = recordingSigner();
    const agent = new J41Agent({
      apiUrl: 'https://api.example.com',
      signer,
      identityName: 'testagent.agentplatform@',
      iAddress: 'iTest',
    });

    const CHALLENGE = 'opaque-server-nonce-no-pipe';
    agent.client.getAuthChallenge = async () => ({
      challengeId: 'c1',
      challenge: CHALLENGE,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    // Stub fetch to avoid real HTTP; capture body to verify the signer's
    // signature went into the request.
    const originalFetch = global.fetch;
    let capturedBody: any = null;
    global.fetch = (async (url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        statusText: 'OK',
        headers: { get: (k: string) => (k === 'set-cookie' ? 'verus_session=tok123; Path=/' : null) },
      };
    }) as any;

    try {
      await agent.authenticate();
    } finally {
      global.fetch = originalFetch;
    }

    assert.strictEqual(signer.calls.length, 1, 'signer should be called exactly once');
    assert.strictEqual(signer.calls[0].kind, 'signMessage');
    assert.strictEqual(signer.calls[0].arg, CHALLENGE);
    assert.strictEqual(capturedBody.signature, `sig:msg:${CHALLENGE.length}`);
    assert.strictEqual(capturedBody.verusId, 'testagent.agentplatform@');
  });

  it('accept job routes through signer.signBrokered with the correct request shape', async () => {
    const signer = recordingSigner();
    let acceptArgs: any = null;
    const agent = new J41Agent({
      apiUrl: 'https://api.example.com',
      signer,
      identityName: 'testagent.agentplatform@',
      iAddress: 'iTest',
    });

    // Mock session token so checkForJobs runs
    agent.client.setSessionToken('tok123');
    agent.client.getMyJobs = async () => ({
      data: [{
        id: 'job-42',
        jobHash: 'jh_abc',
        buyerVerusId: 'buyer.agentplatform@',
        amount: 5,
        currency: 'VRSCTEST',
      }],
    });
    agent.client.acceptJob = async (jobId: string, signature: string, timestamp: number) => {
      acceptArgs = { jobId, signature, timestamp };
      return { ok: true };
    };

    agent.setHandler({
      onJobRequested: async () => 'accept',
    });

    // Drive the private method directly. checkForJobs early-breaks on
    // !running so flip the flag — start() would do the same plus timer setup
    // we don't need here.
    (agent as any).running = true;
    await (agent as any).checkForJobs();

    assert.deepStrictEqual(signer.calls[0], {
      kind: 'signBrokered',
      arg: { type: 'accept', jobId: 'job-42' },
    });
    assert.strictEqual(acceptArgs.jobId, 'job-42');
    assert.strictEqual(acceptArgs.signature, 'sig:brok:accept');
    assert.strictEqual(acceptArgs.timestamp, 1_700_000_000);
  });

  it('respondToDispute routes through signer.signBrokered({type:"dispute_respond"})', async () => {
    const signer = recordingSigner();
    let disputeArgs: any = null;
    const agent = new J41Agent({
      apiUrl: 'https://api.example.com',
      signer,
      identityName: 'testagent.agentplatform@',
      iAddress: 'iTest',
    });

    agent.client.getJob = async () => ({ id: 'job-9', jobHash: 'jh_9', status: 'in_progress' });
    agent.client.respondToDispute = async (jobId: string, body: any) => {
      disputeArgs = { jobId, body };
      return { status: 'responded', dispute: {} };
    };

    await agent.respondToDispute('job-9', { action: 'refund', message: 'because reasons' });

    assert.deepStrictEqual(signer.calls[0], {
      kind: 'signBrokered',
      arg: { type: 'dispute_respond', jobId: 'job-9', action: 'refund' },
    });
    assert.strictEqual(disputeArgs.body.signature, 'sig:brok:dispute_respond');
    assert.strictEqual(disputeArgs.body.timestamp, 1_700_000_000);
  });

  it('autoDeliver routes through signer.signBrokered({type:"deliver"}) with a real SHA-256 hash', async () => {
    const signer = recordingSigner();
    let deliverArgs: any = null;
    const agent = new J41Agent({
      apiUrl: 'https://api.example.com',
      signer,
      identityName: 'testagent.agentplatform@',
      iAddress: 'iTest',
    });

    agent.client.getJob = async () => ({ id: 'job-7', jobHash: 'jh_7', status: 'in_progress' });
    agent.client.deliverJob = async (jobId: string, deliveryHash: string, signature: string, timestamp: number, msg: string) => {
      deliverArgs = { jobId, deliveryHash, signature, timestamp, msg };
      return { ok: true };
    };

    await (agent as any).autoDeliver('job-7');

    assert.strictEqual(signer.calls.length, 1);
    assert.strictEqual(signer.calls[0].kind, 'signBrokered');
    const req: any = signer.calls[0].arg;
    assert.strictEqual(req.type, 'deliver');
    assert.strictEqual(req.jobId, 'job-7');
    // Must be a real 64-char hex SHA-256 (broker policy enforces this)
    assert.match(req.deliveryHash, /^[0-9a-f]{64}$/);

    // And the agent must have passed the broker's signature + timestamp
    // through to the API call unmodified.
    assert.strictEqual(deliverArgs.signature, 'sig:brok:deliver');
    assert.strictEqual(deliverArgs.timestamp, 1_700_000_000);
    assert.strictEqual(deliverArgs.deliveryHash, req.deliveryHash);
  });

  it('attestation signing routes through signer.signMessage (signature verifies)', async () => {
    const kp = generateKeypair('verustest');
    const signer = recordingSigner({ wif: kp.wif });

    const agent = new J41Agent({
      apiUrl: 'https://api.example.com',
      signer,
      identityName: 'testagent.agentplatform@',
      iAddress: 'iTest',
    });
    agent.client.submitAttestation = async () => ({ ok: true });

    const att = await agent.attestDeletion('job-1', 'container-xyz', {
      createdAt: '2025-01-01T00:00:00Z',
      destroyedAt: '2025-01-01T00:05:00Z',
      dataVolumes: ['/tmp/data'],
    });

    assert.strictEqual(signer.calls.length, 1);
    assert.strictEqual(signer.calls[0].kind, 'signMessage');
    // The signed bytes are the canonical-JSON of the payload
    const signedMessage = signer.calls[0].arg as string;
    assert.ok(signedMessage.includes('"jobId":"job-1"'));
    // And the agent's attestation.signature is what the signer returned —
    // we verify it cryptographically.
    assert.ok(verifyMessage(signedMessage, kp.address, att.signature));
  });

  it('status change (deactivate) routes through signer.signMessage', async () => {
    const signer = recordingSigner();
    let statusArgs: any = null;
    const agent = new J41Agent({
      apiUrl: 'https://api.example.com',
      signer,
      identityName: 'testagent.agentplatform@',
      iAddress: 'iTest',
    });
    agent.client.setSessionToken('tok123');
    // Mock the login challenge so deactivate's internal .login() resolves
    agent.client.getAuthChallenge = async () => ({
      challengeId: 'c',
      challenge: 'opaque-challenge-no-pipe',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const originalFetch = global.fetch;
    global.fetch = (async () => ({
      ok: true,
      statusText: 'OK',
      headers: { get: (k: string) => (k === 'set-cookie' ? 'verus_session=tok123' : null) },
    })) as any;

    agent.client.getMyServices = async () => ({ data: [] });
    agent.client.setAgentStatus = async (...args: any[]) => {
      statusArgs = args;
      return { status: 'inactive' };
    };

    try {
      await agent.deactivate({ onChain: false, removeServices: false });
    } finally {
      global.fetch = originalFetch;
    }

    // Two signMessage calls: one for the login challenge, one for the status change
    assert.strictEqual(signer.calls.length, 2);
    assert.strictEqual(signer.calls[0].kind, 'signMessage');
    assert.strictEqual(signer.calls[1].kind, 'signMessage');
    const statusMsg = signer.calls[1].arg as string;
    assert.match(statusMsg, /^J41-STATUS\|Agent:iTest\|Status:inactive\|Ts:\d+\|Nonce:/);
    assert.strictEqual(statusArgs[2], 'sig:msg:' + statusMsg.length);
  });

  it('local WIF fallback still works when no signer is configured (back-compat)', async () => {
    const kp = generateKeypair('verustest');
    const agent = new J41Agent({
      apiUrl: 'https://api.example.com',
      wif: kp.wif,
      identityName: 'testagent.agentplatform@',
      iAddress: 'iTest',
    });
    assert.strictEqual(agent.usesRemoteSigner, false);

    agent.client.submitAttestation = async () => ({ ok: true });

    const att = await agent.attestDeletion('job-1', 'container-xyz', {
      createdAt: '2025-01-01T00:00:00Z',
      destroyedAt: '2025-01-01T00:05:00Z',
    });

    // No signer was called (there is none); local signMessage produced the sig
    // and it verifies against the WIF address.
    assert.ok(att.signature);
    // Recompute canonical bytes the same way attestation.ts does
    const { canonicalize } = require('json-canonicalize');
    const { generateAttestationPayload } = require('../dist/privacy/attestation.js');
    const payload = generateAttestationPayload({
      jobId: 'job-1',
      containerId: 'container-xyz',
      createdAt: '2025-01-01T00:00:00Z',
      destroyedAt: '2025-01-01T00:05:00Z',
      dataVolumes: undefined,
      deletionMethod: undefined,
      attestedBy: 'testagent.agentplatform@',
    });
    assert.ok(verifyMessage(canonicalize(payload), kp.address, att.signature));
  });

  it('signer takes precedence when both wif and signer are configured', async () => {
    const kp = generateKeypair('verustest');
    const signer = recordingSigner();
    const agent = new J41Agent({
      apiUrl: 'https://api.example.com',
      wif: kp.wif,
      signer,
      identityName: 'testagent.agentplatform@',
      iAddress: 'iTest',
    });

    agent.client.submitAttestation = async () => ({ ok: true });

    const att = await agent.attestDeletion('job-1', 'container-xyz', {
      createdAt: '2025-01-01T00:00:00Z',
      destroyedAt: '2025-01-01T00:05:00Z',
    });

    // The signer was used — not the WIF — so signature is the synthetic
    // placeholder, NOT a real Verus signature.
    assert.strictEqual(signer.calls.length, 1);
    assert.ok(att.signature.startsWith('sig:msg:'));
  });
});
