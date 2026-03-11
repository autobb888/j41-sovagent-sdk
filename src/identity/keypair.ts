/**
 * Keypair generation for Verus agents.
 * Uses minimal extracted utilities to avoid @bitgo/utxo-lib dependency issues.
 */

import {
  generateKeypair as verusGenerateKeypair,
  keypairFromWIF as verusKeypairFromWIF,
} from './verus-sign.js';

export interface Keypair {
  /** WIF-encoded private key */
  wif: string;
  /** Compressed public key hex (33 bytes) */
  pubkey: string;
  /** R-address */
  address: string;
}

/**
 * Generate a new keypair for a Verus agent.
 * The private key never leaves the local machine.
 * 
 * @param networkName - 'verus' for mainnet, 'verustest' for testnet (default)
 */
export function generateKeypair(networkName: 'verus' | 'verustest' = 'verustest'): Keypair {
  const kp = verusGenerateKeypair(networkName);
  return {
    wif: kp.wif,
    pubkey: kp.publicKey,
    address: kp.address,
  };
}

/**
 * Restore a keypair from a WIF private key.
 */
export function keypairFromWIF(wif: string, networkName: 'verus' | 'verustest' = 'verustest'): Keypair {
  const kp = verusKeypairFromWIF(wif, networkName);
  return {
    wif: kp.wif,
    pubkey: kp.publicKey,
    address: kp.address,
  };
}
