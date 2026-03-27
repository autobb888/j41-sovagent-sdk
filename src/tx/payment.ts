/**
 * Transaction builder for VRSC payments.
 * Builds and signs standard payment transactions offline using @bitgo/utxo-lib.
 */

// @ts-ignore - VerusCoin fork, no TS declarations
import * as utxolib from '@bitgo/utxo-lib';
import type { Utxo } from '../client/index.js';
import { keypairFromWIF } from '../identity/keypair.js';

const DEFAULT_FEE = 10000; // 0.0001 VRSC in satoshis
const SATS_PER_COIN = 100000000;

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
    if ((utxo as any).script) {
      // i-address UTXO: pass the scriptPubKey so the builder knows how to spend it
      const scriptBuf = Buffer.from((utxo as any).script, 'hex');
      txb.addInput(utxo.txid, utxo.vout, 0xffffffff, scriptBuf);
    } else {
      // R-address UTXO: standard P2PKH
      txb.addInput(utxo.txid, utxo.vout);
    }
  }

  // Payment output — support both R-address and i-address destinations
  let paymentScript: Buffer;
  try {
    paymentScript = utxolib.address.toOutputScript(toAddress, networkObj);
  } catch {
    // If toOutputScript fails (i-address), build a P2ID script manually
    // This shouldn't happen for outgoing payments (destinations are usually R-addresses)
    throw new Error(`Cannot create output script for address: ${toAddress}. Use an R-address as the destination.`);
  }
  txb.addOutput(paymentScript, amountSatoshis);

  // Change output — send change back to the source address
  if (changeSatoshis > 1000) {
    try {
      txb.addOutput(utxolib.address.toOutputScript(changeAddress, networkObj), changeSatoshis);
    } catch {
      // If change address is an i-address, use the script from the first i-address input
      const iUtxoScript = selected.find(u => (u as any).script);
      if (iUtxoScript) {
        txb.addOutput(Buffer.from((iUtxoScript as any).script, 'hex'), changeSatoshis);
      } else {
        throw new Error(`Cannot create change output for address: ${changeAddress}`);
      }
    }
  }

  // Sign all inputs
  for (let i = 0; i < selected.length; i++) {
    txb.sign(i, keyPair, undefined, utxolib.Transaction.SIGHASH_ALL, selected[i].satoshis);
  }

  return txb.build().toHex();
}

export function wifToAddress(wif: string, networkName: 'verus' | 'verustest' = 'verustest'): string {
  return keypairFromWIF(wif, networkName).address;
}

export function wifToPubkey(wif: string, networkName: 'verus' | 'verustest' = 'verustest'): string {
  return keypairFromWIF(wif, networkName).pubkey;
}
