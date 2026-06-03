/**
 * RemoteSigner — abstraction that lets a `J41Agent` operate **without holding
 * the WIF**. The agent passes structured sign-requests to the signer; the
 * signer (typically the dispatcher running outside the untrusted job
 * container) decides whether to sign and what message bytes to bind into the
 * signature.
 *
 * Two surface methods, deliberately distinct:
 *
 * - `signBrokered(req)` — for **protocol-gated** operations: `accept`,
 *   `deliver`, `dispute_respond`. The dispatcher's broker policy
 *   (`j41-dispatcher/src/sign-broker.js`) RECONSTRUCTS the canonical message
 *   bytes from its own authoritative job record — the request only conveys
 *   which protocol type + jobId + the few non-fund-bearing fields the
 *   container is allowed to influence (delivery hash, dispute action). A
 *   compromised container therefore cannot inflate amounts, sign for a
 *   different job, or sign an arbitrary string by lying in this request.
 *
 * - `signMessage(message)` — for arbitrary text (auth challenges, profile
 *   registration payloads, attestations, bounty/status/review payloads).
 *   The signer can still apply its own policy (length limit, refuse anything
 *   shaped like a `J41-<ACTION>|…` protocol message, freshness window, …)
 *   but does NOT reconstruct the bytes — the agent's caller built them.
 *
 * The contract intentionally is `Promise<string>` returning a base64 Verus
 * message signature so the signer can be local (in-process), file-channel,
 * unix-socket, or network without changing the call sites.
 *
 * @example Pure remote-signer mode (broker integration)
 * ```ts
 * const agent = new J41Agent({
 *   apiUrl: 'https://api.junction41.io',
 *   identityName: 'myagent.agentplatform@',
 *   iAddress: 'i7...',
 *   signer: dispatcherFileChannelSigner,  // implements RemoteSigner
 *   // wif: omitted — the WIF lives outside the container, in the dispatcher
 * });
 * ```
 *
 * @example Mixed (signer preferred, WIF as fallback for tests)
 * ```ts
 * const agent = new J41Agent({ apiUrl, wif, signer });
 * // signer is used for every signing path; wif is ignored as long as signer is set.
 * ```
 */

/**
 * Structured sign-request for the broker-gated protocol messages. Only the
 * `type` discriminator + the type-specific non-fund-bearing fields are
 * forwarded to the broker — the broker reads the authoritative job record
 * (amount, currency, buyer, jobHash) directly from the platform and binds
 * those into the signed bytes itself.
 */
export type BrokerSignRequest =
  | {
      type: 'accept';
      /** Job ID the container was dispatched for. The broker MUST verify
       *  this matches the job it associated with this signing channel. */
      jobId: string;
    }
  | {
      type: 'deliver';
      jobId: string;
      /** SHA-256 hex (64 chars) of the delivered content. Not fund-bearing,
       *  but the broker enforces format. */
      deliveryHash: string;
    }
  | {
      type: 'dispute_respond';
      jobId: string;
      action: 'refund' | 'rework' | 'rejected';
    };

/**
 * The broker's response to a brokered sign-request. `timestamp` is the unix
 * second the broker bound into the signature — the agent MUST pass this same
 * timestamp to the platform alongside `signature`, otherwise the platform's
 * verify step recomputes a different message and rejects.
 *
 * `message` is returned for symmetry / debugging / fail-fast assertions —
 * production agent code does not need to inspect it.
 */
export interface BrokerSignResponse {
  signature: string;
  timestamp: number;
  message: string;
}

/**
 * The signer abstraction the agent uses when `J41AgentConfig.signer` is set.
 *
 * Implementations:
 * - Dispatcher file-channel (production): bind-mounted JSON req/resp files +
 *   correlation IDs + timeout; the dispatcher-side watcher runs each request
 *   through `sign-broker.js`.
 * - In-process (tests): wraps a local WIF; see {@link createLocalSigner}.
 */
export interface RemoteSigner {
  /**
   * Sign a structured broker-gated request. The broker reconstructs the
   * exact message bytes from its authoritative job record and signs that —
   * the message bytes are NOT supplied by the caller.
   *
   * @throws if the broker rejects the request (unknown type, jobId mismatch,
   *         bad delivery-hash format, invalid dispute action, etc.).
   */
  signBrokered(req: BrokerSignRequest): Promise<BrokerSignResponse>;

  /**
   * Sign an arbitrary message. Used for non-broker-gated paths (auth
   * challenges, registration payloads, attestations, bounty/status/review
   * payloads). The signer's policy MAY refuse — for example if the bytes
   * look like a `J41-<ACTION>|…` protocol message that should have gone
   * through `signBrokered` — but the agent supplies the bytes.
   *
   * @throws if the signer's policy refuses (oracle-shape, length cap, …).
   */
  signMessage(message: string): Promise<string>;
}

/**
 * Create an in-process signer backed by a local WIF. **For tests and the
 * legacy single-process path only.** Real broker integration uses a
 * different transport (file channel / socket / network).
 *
 * Importing the local signer pulls `signMessage` from `./signer.js`, so this
 * helper is a thin adapter — it does not duplicate crypto.
 */
export function createLocalSigner(wif: string, network: 'verus' | 'verustest' = 'verustest'): RemoteSigner {
  // Lazy require keeps the heavy `@noble/curves` graph off the import path
  // for callers who only need the types (e.g. dispatcher building its file
  // channel client).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { signMessage } = require('./signer.js') as typeof import('./signer.js');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const messages = require('../signing/messages.js') as typeof import('../signing/messages.js');

  return {
    async signMessage(message: string): Promise<string> {
      return signMessage(wif, message, network);
    },

    async signBrokered(req: BrokerSignRequest): Promise<BrokerSignResponse> {
      // Local signer has no authoritative job record — this method exists
      // only so test code can exercise the agent's brokered code paths
      // without standing up a dispatcher. It builds the canonical message
      // bytes from the request alone, which means a local-signer agent has
      // **no broker policy enforcement**. Don't use this in production.
      const timestamp = Math.floor(Date.now() / 1000);
      let message: string;
      switch (req.type) {
        case 'accept': {
          // For brokered accept we don't have buyer/amount/currency/jobHash
          // here; the local signer cannot honestly fulfil this. Reject so
          // tests don't accidentally green-light a path that would silently
          // sign the wrong bytes in production.
          throw new Error(
            'createLocalSigner: signBrokered({type:"accept"}) cannot be served locally — accept requires the authoritative job record. Use a dispatcher-backed RemoteSigner for production paths.',
          );
        }
        case 'deliver': {
          // Audit 2026-06-02 L-SDK-auth-2: jobId-as-jobHash is a deliberate
          // test-only fallback (real production paths use the dispatcher's
          // RemoteSigner which fetches the authoritative jobHash). Gate this
          // path behind J41_LOCAL_SIGNER_TEST_MODE=1 so a production agent
          // accidentally falling through to createLocalSigner never silently
          // signs a malformed deliver message.
          if (process.env.J41_LOCAL_SIGNER_TEST_MODE !== '1') {
            throw new Error(
              'createLocalSigner: signBrokered({type:"deliver"}) requires the authoritative jobHash. Use a dispatcher-backed RemoteSigner in production, or set J41_LOCAL_SIGNER_TEST_MODE=1 for test-only synthetic-jobId paths.',
            );
          }
          message = messages.buildDeliverMessage({
            jobHash: req.jobId,
            deliveryHash: req.deliveryHash,
            timestamp,
          });
          break;
        }
        case 'dispute_respond': {
          if (process.env.J41_LOCAL_SIGNER_TEST_MODE !== '1') {
            throw new Error(
              'createLocalSigner: signBrokered({type:"dispute_respond"}) requires the authoritative jobHash. Use a dispatcher-backed RemoteSigner in production, or set J41_LOCAL_SIGNER_TEST_MODE=1.',
            );
          }
          message = messages.buildDisputeRespondMessage({
            jobHash: req.jobId,
            action: req.action,
            timestamp,
          });
          break;
        }
        default: {
          // Exhaustiveness check for the discriminated union.
          const _exhaustive: never = req;
          throw new Error(`createLocalSigner: unsupported brokered request type: ${JSON.stringify(_exhaustive)}`);
        }
      }
      const signature = signMessage(wif, message, network);
      return { signature, timestamp, message };
    },
  };
}
