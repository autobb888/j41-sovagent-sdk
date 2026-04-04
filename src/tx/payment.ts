/**
 * Transaction builder for VRSC payments.
 * Builds and signs standard payment transactions offline using @bitgo/utxo-lib.
 *
 * Supports:
 * - R-address (P2PKH) inputs and outputs
 * - i-address (P2ID / identity) inputs and outputs
 * - Mixed inputs (spend from both R and i address in one TX)
 */

// @ts-ignore - VerusCoin fork, no TS declarations
import * as utxolib from '@bitgo/utxo-lib';
import type { Utxo } from '../client/index.js';
import { keypairFromWIF } from '../identity/keypair.js';

const DEFAULT_FEE = 10000; // 0.0001 VRSC in satoshis
const SATS_PER_COIN = 100000000;

// i-address version byte (same on mainnet and testnet)
const I_ADDRESS_VERSION = 0x66;

export interface PaymentParams {
  wif: string;
  toAddress: string;
  amount: number;        // Amount in VRSC (not satoshis)
  utxos: Utxo[];
  fee?: number;          // Fee in satoshis (default 10000)
  changeAddress?: string;
  network?: 'verus' | 'verustest';
}

/**
 * Build a P2ID (pay-to-identity) output script for an i-address.
 *
 * Verus identity output script format (36 bytes):
 *   PUSH(5) [COptCCParams: v4, EVAL_IDENTITY, m=0, n=0]
 *   OP_CHECKCRYPTOCONDITION
 *   PUSH(27) [COptCCParams: v4, EVAL_IDENTITY, m=0, n=1, dests=1, type=ID, <20-byte hash>]
 *   OP_DROP
 */
export function buildP2IDScript(iAddress: string): Buffer {
  const decoded = utxolib.address.fromBase58Check(iAddress);
  if (decoded.version !== I_ADDRESS_VERSION) {
    throw new Error(`Not an i-address (version ${decoded.version.toString(16)}, expected ${I_ADDRESS_VERSION.toString(16)}): ${iAddress}`);
  }
  const hash = decoded.hash; // 20-byte identity hash

  return Buffer.concat([
    Buffer.from([
      0x05,                         // PUSH 5 bytes
      0x04, 0x03, 0x00, 0x00, 0x00, // COptCCParams: version=4, evalcode=3 (EVAL_IDENTITY), m=0, n=0, flags=0
      0xcc,                         // OP_CHECKCRYPTOCONDITION
      0x1b,                         // PUSH 27 bytes
      0x04, 0x03, 0x00, 0x01, 0x01, // COptCCParams: version=4, evalcode=3, m=0, n=1, numDests=1
      0x15,                         // PUSH 21 bytes (1 type byte + 20 hash bytes)
      0x04,                         // destination type = 4 (identity)
    ]),
    hash,                           // 20-byte identity hash
    Buffer.from([0x75]),            // OP_DROP
  ]);
}

/**
 * Check if an address is an i-address (identity address).
 */
export function isIAddress(address: string): boolean {
  try {
    const decoded = utxolib.address.fromBase58Check(address);
    return decoded.version === I_ADDRESS_VERSION;
  } catch {
    return false;
  }
}

/**
 * Build an output script for any address (R-address or i-address).
 */
function toOutputScript(address: string, networkObj: any): Buffer {
  if (isIAddress(address)) {
    return buildP2IDScript(address);
  }
  return utxolib.address.toOutputScript(address, networkObj);
}

/**
 * Select UTXOs to cover the target amount (greedy algorithm).
 * Prefers larger UTXOs to minimize inputs.
 */
export function selectUtxos(
  utxos: Utxo[],
  targetAmount: number,
): { selected: Utxo[]; total: number } {
  const targetSatoshis = Math.round(targetAmount * SATS_PER_COIN);
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
 * Build a signed payment transaction.
 * Supports sending from/to both R-addresses and i-addresses.
 *
 * @returns Signed raw transaction hex ready for broadcast
 */
export function buildPayment(params: PaymentParams): string {
  const {
    wif,
    toAddress,
    amount,
    utxos,
    fee = DEFAULT_FEE,
    network = 'verustest',
  } = params;

  const networkObj = network === 'verustest'
    ? utxolib.networks.verustest
    : utxolib.networks.verus;

  const amountSatoshis = Math.round(amount * SATS_PER_COIN);
  const totalNeeded = amountSatoshis + fee;
  const { selected, total: inputTotal } = selectUtxos(utxos, totalNeeded / SATS_PER_COIN);

  const changeAddress = params.changeAddress || keypairFromWIF(wif, network).address;
  const changeSatoshis = inputTotal - amountSatoshis - fee;

  // Build transaction
  const keyPair = utxolib.ECPair.fromWIF(wif, networkObj);
  const txb = new utxolib.TransactionBuilder(networkObj);
  txb.setVersion(4);
  txb.setVersionGroupId(0x892f2085);

  // Add inputs — use script for i-address UTXOs (identity outputs)
  for (const utxo of selected) {
    if (utxo.script) {
      const scriptBuf = Buffer.from(utxo.script, 'hex');
      txb.addInput(utxo.txid, utxo.vout, 0xffffffff, scriptBuf);
    } else {
      txb.addInput(utxo.txid, utxo.vout);
    }
  }

  // Payment output — supports both R-address and i-address destinations
  txb.addOutput(toOutputScript(toAddress, networkObj), amountSatoshis);

  // Change output
  if (changeSatoshis > 1000) {
    txb.addOutput(toOutputScript(changeAddress, networkObj), changeSatoshis);
  }

  // Sign all inputs
  for (let i = 0; i < selected.length; i++) {
    txb.sign(i, keyPair, undefined, utxolib.Transaction.SIGHASH_ALL, selected[i].satoshis);
  }

  return txb.build().toHex();
}

// --- Multi-output payment (dual TX for agent + platform fee) ---

export interface PaymentOutput {
  address: string;
  amount: number;   // in VRSC (not satoshis)
}

export interface MultiPaymentParams {
  wif: string;
  outputs: PaymentOutput[];
  utxos: Utxo[];
  fee?: number;          // Fee in satoshis (default 10000)
  changeAddress?: string;
  network?: 'verus' | 'verustest';
}

/**
 * Build a signed transaction with multiple outputs.
 * Used for sending agent payment + platform fee in a single TX.
 *
 * @returns Signed raw transaction hex ready for broadcast
 */
export interface MultiPaymentResult {
  rawhex: string;
  /** UTXOs consumed by this TX — exclude these from future calls */
  spentUtxos: Array<{ txid: string; vout: number }>;
  /** Change output created — include this as UTXO in future calls */
  changeUtxo: Utxo | null;
}

export function buildMultiPayment(params: MultiPaymentParams): string;
export function buildMultiPayment(params: MultiPaymentParams & { returnDetails: true }): MultiPaymentResult;
export function buildMultiPayment(params: MultiPaymentParams & { returnDetails?: boolean }): string | MultiPaymentResult {
  const {
    wif,
    outputs,
    utxos,
    fee = DEFAULT_FEE,
    network = 'verustest',
  } = params;

  if (outputs.length === 0) throw new Error('At least one output required');

  const networkObj = network === 'verustest'
    ? utxolib.networks.verustest
    : utxolib.networks.verus;

  const totalOutputSatoshis = outputs.reduce((sum, o) => sum + Math.round(o.amount * SATS_PER_COIN), 0);
  const totalNeeded = totalOutputSatoshis + fee;
  const { selected, total: inputTotal } = selectUtxos(utxos, totalNeeded / SATS_PER_COIN);

  const changeAddress = params.changeAddress || keypairFromWIF(wif, network).address;
  const changeSatoshis = inputTotal - totalOutputSatoshis - fee;

  const keyPair = utxolib.ECPair.fromWIF(wif, networkObj);
  const txb = new utxolib.TransactionBuilder(networkObj);
  txb.setVersion(4);
  txb.setVersionGroupId(0x892f2085);

  // Inputs
  for (const utxo of selected) {
    if (utxo.script) {
      txb.addInput(utxo.txid, utxo.vout, 0xffffffff, Buffer.from(utxo.script, 'hex'));
    } else {
      txb.addInput(utxo.txid, utxo.vout);
    }
  }

  // Multiple outputs
  for (const output of outputs) {
    txb.addOutput(toOutputScript(output.address, networkObj), Math.round(output.amount * SATS_PER_COIN));
  }

  // Change
  const hasChange = changeSatoshis > 1000;
  const changeVout = outputs.length; // change output index = after all payment outputs
  if (hasChange) {
    txb.addOutput(toOutputScript(changeAddress, networkObj), changeSatoshis);
  }

  // Sign
  for (let i = 0; i < selected.length; i++) {
    txb.sign(i, keyPair, undefined, utxolib.Transaction.SIGHASH_ALL, selected[i].satoshis);
  }

  const tx = txb.build();
  const rawhex = tx.toHex();

  if (!params.returnDetails) return rawhex;

  const txid = tx.getId();
  const changeScript = hasChange ? toOutputScript(changeAddress, networkObj).toString('hex') : '';
  return {
    rawhex,
    spentUtxos: selected.map(u => ({ txid: u.txid, vout: u.vout })),
    changeUtxo: hasChange ? {
      txid,
      vout: changeVout,
      satoshis: changeSatoshis,
      script: changeScript,
      address: changeAddress,
    } as Utxo : null,
  };
}

export function wifToAddress(wif: string, networkName: 'verus' | 'verustest' = 'verustest'): string {
  return keypairFromWIF(wif, networkName).address;
}

export function wifToPubkey(wif: string, networkName: 'verus' | 'verustest' = 'verustest'): string {
  return keypairFromWIF(wif, networkName).pubkey;
}
