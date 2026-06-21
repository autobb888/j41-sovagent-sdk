/**
 * A login consent challengeHash is always SHA-256 hex (64 hex chars). Refuse to
 * sign anything else — a compromised/MITM'd API could otherwise hand back an
 * arbitrary string to be signed with the agent's key (signing oracle). This is
 * an allowlist on the signed bytes, complementing assertNotProtocolMessage.
 */
export function assertConsentChallengeHash(hash: unknown): asserts hash is string {
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash)) {
    throw new Error('Invalid login challenge: challengeHash must be a 64-char hex SHA-256 digest');
  }
}
