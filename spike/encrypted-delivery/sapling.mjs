/**
 * Daemon-less Sapling crypto for the encrypted-delivery spike.
 *
 * This is the agent's half of encrypted delivery: the dispatcher box has no Verus
 * daemon, so encrypting a deliverable to the buyer must happen in pure JS. It also
 * plays the buyer's half (decrypt), so one box can drive the whole loop.
 *
 * NOT in src/ on purpose: the SDK is a published npm package and veruszsupportlib
 * is not a declared dependency. Importing this from src/ would break every
 * downstream install. Promote it only once interop is proven AND the lib is
 * vendored with a pinned hash.
 *
 * Everything is raw hex. Addresses are 43 bytes (11-byte diversifier + 32-byte
 * pk_d); bech32 never appears, so the mainnet `zs1` / testnet `ztestsapling1`
 * split cannot cause a wrong-chain parse.
 */
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const LIB_PATH = process.env.ZSUPPORT_LIB
  ?? path.resolve(process.cwd(), '../spike-veruscryptolib/dist/index.es.js');

let _z;
async function zlib() {
  if (!_z) {
    try {
      _z = await import(pathToFileURL(LIB_PATH).href);
    } catch (e) {
      throw new Error(
        `Could not load veruszsupportlib from ${LIB_PATH}\n` +
        `Clone it beside this repo:\n` +
        `  git clone https://github.com/iamahmedshahh/zsupportextension ../spike-veruscryptolib\n` +
        `or set ZSUPPORT_LIB to its dist/index.es.js\nCause: ${e.message}`,
      );
    }
  }
  return _z;
}

let _P;
async function primitives() {
  if (!_P) {
    const m = await import('verus-typescript-primitives');
    _P = m.default ?? m;
  }
  return _P;
}

const hex = (u8) => Buffer.from(u8).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));

/** Fresh ephemeral Sapling key. The ivk never leaves this machine. */
export async function keygen() {
  const z = await zlib();
  const keys = z.z_getEncryptionAddress({
    seed: randomBytes(32),
    hdIndex: 0,
    encryptionIndex: 0,
  });
  return { addressHex: hex(keys.address), ivkHex: hex(keys.ivk) };
}

/** The agent's encrypt: deliverable → ciphertext for the buyer's address. */
export async function encryptToAddress(addressHex, plaintextBuf) {
  const z = await zlib();
  const out = z.encryptData({ address: bytes(addressHex), data: Uint8Array.from(plaintextBuf) });
  return { objectdataHex: hex(out.objectdata), epkHex: hex(out.ephemeralPublicKey) };
}

/** The buyer's decrypt. Fails closed on a wrong ivk. */
export async function decryptWithIvk({ objectdataHex, epkHex, ivkHex }) {
  const z = await zlib();
  const pt = z.decryptData({
    objectdata: bytes(objectdataHex),
    epk: bytes(epkHex),
    ivk: bytes(ivkHex),
  });
  return Buffer.from(pt);
}

/**
 * Pull the encrypted DataDescriptor out of the wallet's GenericResponse.
 * Also asserts the descriptor carries NO inline ivk/ssk — if it did, the platform
 * could read the blob and the whole design would be void. The backend rejects this
 * too; we check independently rather than trust it.
 */
export async function extractEncryptedDescriptor(responseBlobB64) {
  const P = await primitives();
  const genResp = new P.GenericResponse();
  genResp.fromBuffer(Buffer.from(responseBlobB64, 'base64'));

  const zero = new P.BigNumber(0);
  for (const detail of genResp.details || []) {
    const dd = detail?.data;
    if (!dd || !Buffer.isBuffer(dd.objectdata) || !Buffer.isBuffer(dd.epk)) continue;

    if (dd.flags.and(P.DataDescriptor.FLAG_INCOMING_VIEWING_KEY_PRESENT).gt(zero) ||
        dd.flags.and(P.DataDescriptor.FLAG_SYMMETRIC_ENCRYPTION_KEY_PRESENT).gt(zero)) {
      throw new Error('Wallet response embeds a decryption key inline — anyone could read this blob');
    }
    return { objectdataHex: dd.objectdata.toString('hex'), epkHex: dd.epk.toString('hex') };
  }
  throw new Error('No encrypted DataDescriptor found in the wallet response');
}

/**
 * Unwrap the decrypted plaintext. The wallet double-wraps it:
 *   VdxfUniValue → inner DataDescriptor → AppEncryptionResponseDetails
 * Calling fromBuffer on the raw plaintext will not work.
 */
export async function unwrapAppEncryptionResponse(plaintextBuf) {
  const P = await primitives();

  const uni = new P.VdxfUniValue();
  uni.fromBuffer(plaintextBuf);

  const key = P.DataDescriptorKey.vdxfid;
  const entry = (uni.values || []).find((v) => v[key]);
  if (!entry) throw new Error('Decrypted payload has no DataDescriptor entry');

  const resp = new P.AppEncryptionResponseDetails();
  resp.fromBuffer(entry[key].objectdata);

  // NOTE: verus-typescript-primitives' SaplingPaymentAddress exposes `d` / `pk_d`
  // (snake_case), not `pkD` as the original brief assumed — confirmed by reading
  // dist/pbaas/SaplingPaymentAddress.d.ts. `pkD` is undefined on the real class and
  // would have silently truncated the address to 11 bytes.
  const addr = Buffer.concat([resp.address.d, resp.address.pk_d]);
  return {
    addressHex: addr.toString('hex'),
    ivkHex: Buffer.from(resp.incomingViewingKey).toString('hex'),
    requestId: resp.requestID ? resp.requestID.toIAddress() : null,
    hasSpendingKey: !!resp.extendedSpendingKey,
  };
}
