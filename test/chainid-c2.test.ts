import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const bs58check = require('bs58check');
const { signChallenge } = require('../dist/identity/verus-sign.js');
const { generateKeypair } = require('../dist/identity/keypair.js');

// Audit finding C2: the mainnet ('verus') branch of signChallenge hardcodes the
// VRSC system chain i-address. An invalid base58check literal makes
// IdentitySignature construction throw "Invalid checksum" on every mainnet call.
describe('Audit C2 — mainnet chain-id is a valid base58check i-address', () => {
  // Decode helper that tolerates both CJS and ESM-default shapes of bs58check.
  const decode = (bs58check.decode || bs58check.default.decode).bind(
    bs58check.default || bs58check,
  );

  it('mainnet chain-id decodes as a valid Verus i-address (version byte 102)', () => {
    // The chain-id literal must be a valid base58check string. We assert via the
    // observable behavior of signChallenge below, but also pin the canonical value.
    const CORRECT = 'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV';
    const payload = decode(CORRECT);
    assert.strictEqual(payload.length, 21, 'i-address payload is 1 version + 20 hash160 bytes');
    assert.strictEqual(payload[0], 102, 'Verus i-address version byte is 102 (0x66)');
  });

  it("signChallenge(..., 'verus') constructs without throwing on mainnet", () => {
    // Throwaway key — we only care that the chain-id no longer aborts construction.
    const kp = generateKeypair('verus');
    assert.doesNotThrow(() => {
      signChallenge(kp.wif, 'any message', kp.address, 'verus');
    }, /Invalid checksum/);
  });
});
