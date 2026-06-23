/**
 * Offline (daemon-less) verification of a platform job-record witness signature.
 *
 * The witness signature is a CIdentitySignature v2 blob (base64, starts `Ag…`)
 * produced by VerusID `signdata`. It does NOT sign `sha256(JCS(record))`
 * directly: VerusID binds the signing block height + a data prefix into the
 * actually-signed hash. This module reconstructs that height/prefix-bound hash
 * exactly the way the daemon does and verifies it with `@bitgo/utxo-lib`'s
 * `IdentitySignature.verifyHashOffline`, so verification is pure-JS and needs no
 * verusd.
 *
 * The bound hash (CIdentitySignature v2, hashType SHA256) is:
 *
 *   sha256( chainId || heightLE(4) || identity || varslice("Verus signed data:\n") || datahash )
 *
 * where `datahash = sha256(JCS(record))` is used directly as the `_msgHash`
 * (signdata over an externally supplied data hash — the daemon does NOT re-hash
 * it through the message-varslice path). This was settled empirically against
 * the golden vector: the recovered R-address matches agentplatform@'s on-chain
 * primaryAddresses only under this interpretation.
 *
 * MAINTAINER NOTE: this pairs with the DAEMON's `signdata` (signature over a hash),
 * NOT with the SDK's `signChallenge`/`signMessageOffline` (which wrap a UTF-8
 * challenge through `hashMessage`). The two constructions differ on purpose — do
 * NOT "align" this verifier with `signChallenge`; that would break it (it would
 * then recover a different, wrong address). The golden vector is the regression gate.
 *
 * TRUST ROOT: the signer's primary addresses come from `client.getIdentityKeys()`
 * (the identity's on-chain keys), never from the witness blob — so `verified:true`
 * is exactly as trustworthy as that channel. On mainnet the client enforces
 * `J41_PLATFORM_SIGNER` over the getIdentityKeys response; on testnet it is trusted.
 */

import * as crypto from 'crypto';
import { canonicalize } from 'json-canonicalize';

// @ts-ignore - VerusCoin fork, no bundled types
import * as utxolib from '@bitgo/utxo-lib';

const IdentitySignature = utxolib.IdentitySignature;
const networks = utxolib.networks;
// fromBase58Check lives on the address module of the lib
// @ts-ignore
const { fromBase58Check } = require('@bitgo/utxo-lib/dist/src/address');

/** Witness record / block / response shapes (re-exported via src/index.ts). */
export interface WitnessRecord {
  amount: number;
  buyerVerusId: string;
  completedAt: string;
  currency: string;
  jobHash: string;
  schemaVersion: number;
  sellerVerusId: string;
  serviceId: string | null;
  status: string;
}

export interface WitnessBlock {
  schemaVersion: number;
  signedBy: string;
  signedByName: string;
  signature: string;
  signatureHeight: number;
  algorithm: string;
}

export interface JobWitnessResponse {
  record: WitnessRecord;
  witness: WitnessBlock;
}

/** Minimal shape of the client used by {@link verifyWitness}. */
export interface IdentityKeysResolver {
  getIdentityKeys(idOrName: string): Promise<{
    iaddress: string;
    name: string;
    primaryAddresses: string[];
    minimumSignatures: number;
    cachedAt?: string;
    platformSignature?: string;
  }>;
}

export type NetworkName = 'verus' | 'verustest';

/**
 * The system chain-id (VerusID "signdata" binds this into the hash).
 * Mirrors `signChallenge` in `verus-sign.ts`.
 */
const CHAIN_ID: Record<NetworkName, string> = {
  verustest: 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq',
  // DEFAULT_VERUS_CHAINID — mainnet VRSC system i-address
  verus: 'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV',
};

const VERUS_DATA_SIGNATURE_PREFIX_STRING = 'Verus signed data:\n';

/** varint-length-prefixed encoding of a buffer (matches utxo-lib writeVarSlice for <0xfd). */
function varSlice(buf: Buffer): Buffer {
  const len = buf.length;
  if (len < 0xfd) {
    return Buffer.concat([Buffer.from([len]), buf]);
  }
  if (len <= 0xffff) {
    const head = Buffer.alloc(3);
    head.writeUInt8(0xfd, 0);
    head.writeUInt16LE(len, 1);
    return Buffer.concat([head, buf]);
  }
  const head = Buffer.alloc(5);
  head.writeUInt8(0xfe, 0);
  head.writeUInt32LE(len, 1);
  return Buffer.concat([head, buf]);
}

const PREFIX_VARSLICE = varSlice(Buffer.from(VERUS_DATA_SIGNATURE_PREFIX_STRING, 'utf-8'));

/**
 * Stage 1: canonicalize the record (JCS / RFC 8785) and sha256 it.
 * @returns lowercase hex sha256 of `canonicalize(record)`.
 */
export function jcsDatahash(record: unknown): string {
  const jcs = canonicalize(record);
  return crypto.createHash('sha256').update(Buffer.from(jcs, 'utf-8')).digest('hex');
}

/**
 * Reconstruct the CIdentitySignature v2 height/prefix-bound hash that the
 * signer actually signed for a `signdata` over `datahash`.
 */
function boundHash(
  chainIdStr: string,
  identityStr: string,
  blockHeight: number,
  datahash: Buffer,
): Buffer {
  const chainId: Buffer = Buffer.from(fromBase58Check(chainIdStr).hash);
  const identity: Buffer = Buffer.from(fromBase58Check(identityStr).hash);
  const heightBuf = Buffer.alloc(4);
  heightBuf.writeUInt32LE(blockHeight, 0);
  return crypto
    .createHash('sha256')
    .update(chainId)
    .update(heightBuf)
    .update(identity)
    .update(PREFIX_VARSLICE)
    .update(datahash)
    .digest();
}

/**
 * Stage 2: cryptographically verify a platform witness signature, fully offline.
 *
 * Reconstructs the JCS datahash, parses the CIdentitySignature v2 blob, rebuilds
 * the height/prefix-bound hash, recovers the signer for each embedded signature,
 * and confirms that at least `minimumSignatures` of the identity's on-chain
 * `primaryAddresses` (from `client.getIdentityKeys`) signed it.
 *
 * @returns `{ verified: true }` only on a genuine match; otherwise
 *          `{ verified: false, reason }`.
 */
export async function verifyWitness(
  record: WitnessRecord | unknown,
  witness: WitnessBlock,
  client: IdentityKeysResolver,
  network: NetworkName = 'verustest',
): Promise<{ verified: boolean; reason?: string }> {
  try {
    if (witness.algorithm !== 'verusid-signdata-sha256') {
      return { verified: false, reason: 'unsupported_algorithm' };
    }

    const datahashHex = jcsDatahash(record);
    const datahash = Buffer.from(datahashHex, 'hex');

    const networkObj = network === 'verustest' ? networks.verustest : networks.verus;
    const chainIdStr = CHAIN_ID[network];

    // Parse the blob. fromBuffer is an *instance* method that reads
    // version/hashType/blockHeight/signatures from the buffer; chainId + identity
    // are supplied by us (they are not serialized into the blob).
    const idSig = new IdentitySignature(networkObj);
    let blob: Buffer;
    try {
      blob = Buffer.from(witness.signature, 'base64');
    } catch {
      return { verified: false, reason: 'malformed_signature' };
    }
    idSig.fromBuffer(blob, 0, chainIdStr, witness.signedBy);

    if (idSig.version !== 2) {
      return { verified: false, reason: 'unsupported_signature_version' };
    }
    if (!idSig.signatures || idSig.signatures.length === 0) {
      return { verified: false, reason: 'no_signatures' };
    }

    // Cross-check the embedded block height against the witness metadata.
    if (
      typeof witness.signatureHeight === 'number' &&
      idSig.blockHeight !== witness.signatureHeight
    ) {
      return { verified: false, reason: 'height_mismatch' };
    }

    // Resolve the signer's on-chain primary addresses + multisig threshold.
    const keys = await client.getIdentityKeys(witness.signedBy);
    const primaryAddresses: string[] = Array.isArray(keys?.primaryAddresses)
      ? keys.primaryAddresses
      : [];
    const minSigs =
      typeof keys?.minimumSignatures === 'number' && keys.minimumSignatures > 0
        ? keys.minimumSignatures
        : 1;
    if (primaryAddresses.length === 0) {
      return { verified: false, reason: 'no_signer_addresses' };
    }

    // Reconstruct the actually-signed hash and verify each signature against
    // each primary address. verifyHashOffline(hash, signingAddress) returns an
    // array<boolean> (one per embedded signature) for the given address.
    const hash = boundHash(chainIdStr, witness.signedBy, idSig.blockHeight, datahash);

    // Count distinct primary addresses that produced a valid signature.
    // utxo-lib's verifyHashOffline does `console.log(e)` on a failed recovery
    // (expected for tampered inputs / non-matching addresses); silence it so a
    // legitimate `verified:false` does not spam the caller's stderr.
    const matchedAddresses = new Set<string>();
    const origConsoleLog = console.log;
    console.log = () => {};
    try {
      for (const addr of primaryAddresses) {
        const results: boolean[] = idSig.verifyHashOffline(hash, addr);
        if (Array.isArray(results) && results.some((r) => r === true)) {
          matchedAddresses.add(addr);
        }
      }
    } finally {
      console.log = origConsoleLog;
    }

    if (matchedAddresses.size >= minSigs) {
      return { verified: true };
    }
    return {
      verified: false,
      reason: `insufficient_signatures: ${matchedAddresses.size}/${minSigs}`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { verified: false, reason: `error:${msg}` };
  }
}
