/**
 * Identity update transaction builder.
 * Builds and signs `updateidentity` transactions offline using @bitgo/utxo-lib.
 * No Verus daemon required — uses platform APIs for chain data.
 */

// @ts-ignore - VerusCoin fork, no TS declarations
import * as utxolib from '@bitgo/utxo-lib';
// @ts-ignore - VerusCoin fork dependency
import { Identity, IdentityScript } from 'verus-typescript-primitives';

import type { RawIdentityData, Utxo } from '../client/index.js';
import { assertContentmultimapValueSizes } from '../onboarding/vdxf.js';

const DEFAULT_FEE = 10000; // 0.0001 VRSC in satoshis
const SATS_PER_COIN = 100000000;

export const IDENTITY_EXPIRY_DELTA = 200;

export interface IdentityUpdateParams {
  /** Agent's WIF key */
  wif: string;
  /** Raw identity data from platform (GET /v1/me/identity/raw) */
  identityData: RawIdentityData;
  /** Agent's UTXOs for funding the transaction fee */
  utxos: Utxo[];
  /** VDXF key-value pairs to ADD to contentmultimap (nested DD objects or hex strings) */
  vdxfAdditions: Record<string, unknown[]>;
  /** Network (default: verustest) */
  network?: 'verus' | 'verustest';
  /** Fee in satoshis (default: 10000 = 0.0001 VRSC) */
  fee?: number;
  /** New revocation authority i-address (if changing) */
  revocationauthority?: string;
  /** New recovery authority i-address (if changing) */
  recoveryauthority?: string;
  /** Clear existing contentmultimap before applying additions (for migration) */
  clearContentmultimap?: boolean;
  /** Block height at which the transaction expires. If omitted, falls back to identityData.blockHeight + IDENTITY_EXPIRY_DELTA. */
  expiryHeight?: number;
}

/**
 * Select UTXOs to cover the target amount (simple greedy algorithm).
 * Prefers larger UTXOs to minimize inputs.
 */
function selectUtxos(utxos: Utxo[], targetSatoshis: number): { selected: Utxo[]; total: number } {
  // Sort descending by value
  const sorted = [...utxos].sort((a, b) => b.satoshis - a.satoshis);
  const selected: Utxo[] = [];
  let total = 0;

  for (const utxo of sorted) {
    selected.push(utxo);
    total += utxo.satoshis;
    if (total >= targetSatoshis) break;
  }

  if (total < targetSatoshis) {
    throw new Error(`Insufficient funds: need ${targetSatoshis} satoshis, have ${total}`);
  }

  return { selected, total };
}

/**
 * Build a signed updateidentity transaction that adds VDXF data to contentmultimap.
 *
 * @returns Signed raw transaction hex ready for broadcast
 */
export function buildIdentityUpdateTx(params: IdentityUpdateParams): string {
  const {
    wif,
    identityData,
    utxos,
    vdxfAdditions,
    network = 'verustest',
    fee = DEFAULT_FEE,
    revocationauthority,
    recoveryauthority,
    clearContentmultimap = false,
  } = params;

  const networkObj = network === 'verustest'
    ? utxolib.networks.verustest
    : utxolib.networks.verus;

  // Validate required data
  if (!identityData.prevOutput) {
    throw new Error('Identity prevOutput is required (previous identity transaction output)');
  }
  if (!identityData.identity) {
    throw new Error('Identity data is required');
  }
  if (utxos.length === 0) {
    throw new Error('At least one UTXO is required to fund the transaction fee');
  }

  // 1. Build contentmultimap (clear existing or merge)
  const currentCmm: Record<string, unknown[]> = {};

  // Copy existing contentmultimap (unless clearing for migration)
  // Always filter out MULTIMAPREMOVE_KEY — removal instructions must not persist in identity state
  const MULTIMAPREMOVE_KEY = 'i5Zkx5Z7tEfh42xtKfwbJ5LgEWE9rEgpFY';
  if (!clearContentmultimap && identityData.identity.contentmultimap) {
    for (const [key, values] of Object.entries(identityData.identity.contentmultimap)) {
      if (key === MULTIMAPREMOVE_KEY) continue; // never carry forward removal instructions
      currentCmm[key] = Array.isArray(values) ? [...values] : [values];
    }
  }

  // Fail loud if any new value would silently truncate on-chain (>~5.5KB script
  // element) — e.g. too many/large services serialized into one entry. Guard the
  // ADDITIONS only; existing on-chain values already fit (they were stored).
  assertContentmultimapValueSizes(vdxfAdditions);

  // Apply VDXF data (replace existing keys, add new ones)
  for (const [key, values] of Object.entries(vdxfAdditions)) {
    currentCmm[key] = [...values];
  }

  // 2. Build updated identity JSON (matching getidentity RPC output format)
  const idJson: Record<string, unknown> = {
    version: identityData.identity.version ?? 3,
    flags: identityData.identity.flags ?? 0,
    minimumsignatures: identityData.identity.minimumsignatures,
    primaryaddresses: identityData.identity.primaryaddresses,
    parent: identityData.identity.parent,
    name: identityData.identity.name,
    contentmap: identityData.identity.contentmap || {},
    contentmultimap: currentCmm,
    revocationauthority: revocationauthority || identityData.identity.revocationauthority,
    recoveryauthority: recoveryauthority || identityData.identity.recoveryauthority,
    systemid: identityData.identity.systemid || identityData.identity.parent,
    timelock: 0,
  };

  // 3. Create Identity object and get output script
  const identity = Identity.fromJson(idJson);
  const idOutputScript = IdentityScript.fromIdentity(identity).toBuffer();

  // 4. Create key pair from WIF
  const keyPair = utxolib.ECPair.fromWIF(wif, networkObj);
  try {
  const agentAddress = keyPair.getAddress();
  const agentScript = utxolib.address.toOutputScript(agentAddress, networkObj);

  // SECURITY: refuse to sign unless this key is a primary address of the
  // identity the (semi-trusted) API returned. Defeats a doctored/MITM'd
  // getidentity response that substitutes attacker primaryaddresses (which
  // would otherwise let us sign away control of our own identity), and guards
  // against accidentally locking ourselves out.
  const primaryAddrs = identityData.identity.primaryaddresses;
  if (!Array.isArray(primaryAddrs) || !primaryAddrs.includes(agentAddress)) {
    throw new Error('Refusing to build identity update: signing key is not a primary address of the returned identity (possible tampered getidentity response).');
  }
  const minSigs = identityData.identity.minimumsignatures;
  if (typeof minSigs === 'number' && (minSigs < 1 || minSigs > primaryAddrs.length)) {
    throw new Error('Refusing to build identity update: implausible minimumsignatures in the returned identity.');
  }

  // 5. Select UTXOs to cover fee — only use R-address UTXOs (not i-address)
  // i-address UTXOs (e.g. from job payments) have a different script and can't be
  // signed with a simple P2PKH signature.
  const rAddressUtxos = utxos.filter(u => u.satoshis > 0 && (!u.address || u.address === agentAddress));
  if (rAddressUtxos.length === 0) {
    throw new Error(`No spendable R-address UTXOs for fee. Fund ${agentAddress} with at least 0.0001 VRSC.`);
  }
  const { selected: selectedUtxos, total: totalInput } = selectUtxos(rAddressUtxos, fee);

  // 6. Build the transaction
  const txb = new utxolib.TransactionBuilder(networkObj);
  txb.setVersion(4);
  const expiry = (Number.isInteger(params.expiryHeight) && (params.expiryHeight as number) > 0)
    ? (params.expiryHeight as number)
    : (identityData.blockHeight + IDENTITY_EXPIRY_DELTA);
  txb.setExpiryHeight(expiry);
  txb.setVersionGroupId(0x892f2085); // Sapling version group ID

  // Output 0: Updated identity (value=0)
  txb.addOutput(idOutputScript, 0);

  // Inputs: UTXOs for fee funding
  for (const utxo of selectedUtxos) {
    const txidBuf = Buffer.from(utxo.txid, 'hex').reverse(); // txid is little-endian
    txb.addInput(txidBuf, utxo.vout, 0xffffffff, agentScript);
  }

  // Output 1: Change (input total minus fee)
  const change = totalInput - fee;
  if (change > 0) {
    txb.addOutput(agentScript, change);
  }

  // Input: Previous identity UTXO (spending the identity to update it)
  const prevIdTxid = Buffer.from(identityData.prevOutput.txid, 'hex').reverse();
  const prevIdScript = Buffer.from(identityData.prevOutput.scriptHex, 'hex');
  txb.addInput(prevIdTxid, identityData.prevOutput.vout, 0xffffffff, prevIdScript);

  // 7. Sign all inputs
  const SIGHASH_ALL = utxolib.Transaction.SIGHASH_ALL;

  // Sign UTXO inputs
  for (let i = 0; i < selectedUtxos.length; i++) {
    txb.sign(i, keyPair, undefined, SIGHASH_ALL, selectedUtxos[i].satoshis);
  }

  // Sign identity input (value=0 for identity UTXOs)
  const identityIdx = selectedUtxos.length; // identity input is after all UTXO inputs
  txb.sign(identityIdx, keyPair, undefined, SIGHASH_ALL, Math.round(identityData.prevOutput.value * SATS_PER_COIN));

  // 8. Build and return signed transaction hex
  const signedTx = txb.build();
  return signedTx.toHex();
  } finally {
    // Wipe the private scalar from memory on every exit path (mirror
    // verus-sign.ts zeroization). Best-effort — underlying libs keep copies.
    try {
      const d: any = (keyPair as any).d;
      if (d && d.words && typeof d.words.fill === 'function') d.words.fill(0);
      if (d && typeof d.toBuffer === 'function') { const b = d.toBuffer(32); if (b && b.fill) b.fill(0); }
    } catch { /* best-effort */ }
  }
}
