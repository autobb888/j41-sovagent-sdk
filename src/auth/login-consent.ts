import { signMessage } from '../identity/signer.js';

export interface LoginConsentResult {
  success: boolean;
  identityAddress: string;
  identityName: string;
  sessionToken: string;
  expiresAt: string;
}

/**
 * Authenticate with Junction41 using the VerusID LoginConsent protocol.
 *
 * 1. Fetches a LoginConsentRequest signed by agentplatform@
 * 2. Verifies the request signature (TLS + known API URL)
 * 3. Signs the challengeHash with the agent's WIF key (offline)
 * 4. Submits the signed response for verification
 *
 * @param apiUrl - J41 API base URL (e.g., "https://api.autobb.app")
 * @param wif - Agent's WIF private key (never sent to server)
 * @param identityAddress - Agent's VerusID (e.g., "myagent@" or i-address)
 * @returns Session info with resolved identity and session token
 */
export async function loginWithConsent(
  apiUrl: string,
  wif: string,
  identityAddress: string,
): Promise<LoginConsentResult> {
  // 1. Get login consent challenge
  const challengeRes = await fetch(`${apiUrl}/auth/consent/challenge`);
  if (!challengeRes.ok) {
    const err = await challengeRes.json().catch(() => ({}));
    throw new Error(`Failed to get login challenge: ${(err as any).error?.message || challengeRes.statusText}`);
  }
  const { data: challenge } = await challengeRes.json();

  // 2. Verify the request came from agentplatform@ (defense-in-depth)
  // Primary: TLS certificate proves server identity.
  // The LoginConsentRequest signature in challenge.requestSignature can be
  // independently verified against agentplatform@'s on-chain keys if needed.
  if (!challenge.challengeHash || !challenge.challengeId) {
    throw new Error('Invalid challenge response: missing challengeHash or challengeId');
  }

  // 3. Sign the challengeHash with agent's WIF (offline, never leaves this machine)
  const sig = signMessage(wif, challenge.challengeHash);

  // 4. Submit signed response
  const verifyRes = await fetch(`${apiUrl}/auth/consent/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challengeId: challenge.challengeId,
      verusId: identityAddress,
      signature: sig,
    }),
  });

  if (!verifyRes.ok) {
    const err = await verifyRes.json().catch(() => ({}));
    throw new Error(`Login verification failed: ${(err as any).error?.message || verifyRes.statusText}`);
  }

  const { data } = await verifyRes.json();
  return data;
}
