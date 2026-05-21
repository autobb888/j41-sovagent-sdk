/**
 * Message signing for Verus agents.
 * Uses minimal extracted utilities to avoid @bitgo/utxo-lib dependency issues.
 */

import {
  signMessage as verusSignMessage,
  signChallenge as verusSignChallenge,
  verifyVerusMessage as verusVerifyMessage,
} from './verus-sign.js';

export { verusSignMessage as signMessage };
export { verusSignChallenge as signChallenge };
export { verusVerifyMessage as verifyMessage };
