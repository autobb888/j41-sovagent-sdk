/**
 * J41Client — REST client for the Junction41 API.
 * Handles authentication, session management, and all API calls.
 */

import type { DeletionAttestation } from '../privacy/attestation.js';
import type { SessionInput } from '../onboarding/validation.js';
import { keypairFromWIF } from '../identity/keypair.js';
import { signMessage as verusSignMessage } from '../identity/signer.js';

export interface J41ClientConfig {
  /** J41 API base URL (e.g. https://api.autobb.app) */
  apiUrl: string;
  /** Session cookie (set after login) */
  sessionToken?: string;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** Max retry attempts for transient failures (default: 3) */
  maxRetries?: number;
  /** Called on 401/403 to re-authenticate before retry */
  onSessionExpired?: () => Promise<void>;
}

export class J41Client {
  private baseUrl: string;
  private sessionToken: string | null;
  private timeout: number;
  private maxRetries: number;
  private onSessionExpired: (() => Promise<void>) | null;

  constructor(config: J41ClientConfig) {
    this.baseUrl = config.apiUrl.replace(/\/+$/, '');
    this.sessionToken = config.sessionToken || null;
    this.timeout = config.timeout || 30_000;
    this.maxRetries = config.maxRetries ?? 3;
    this.onSessionExpired = config.onSessionExpired || null;
  }

  /** Set the re-auth callback (used by J41Agent to wire login()) */
  setOnSessionExpired(cb: (() => Promise<void>) | null): void {
    this.onSessionExpired = cb;
  }

  setSessionToken(token: string): void {
    // Reject tokens with control characters to prevent header injection
    if (/[\r\n\x00-\x1f]/.test(token)) {
      throw new J41Error('Session token contains invalid characters', 'INVALID_TOKEN', 400);
    }
    this.sessionToken = token;
  }

  clearSessionToken(): void {
    this.sessionToken = null;
  }

  getSessionToken(): string | null {
    return this.sessionToken;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  /** Check if an error is retryable (transient network/server failure) */
  private isRetryable(e: unknown): boolean {
    if (e instanceof J41Error) {
      // 429 = rate limited, 5xx = server error
      return e.statusCode === 429 || e.statusCode >= 500;
    }
    // Network errors (not our timeout) are retryable
    if (e instanceof Error && e.name !== 'AbortError') {
      return true;
    }
    return false;
  }

  /** Core request logic (single attempt) */
  private async _doRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const headers: Record<string, string> = {
        'Accept': 'application/json',
      };

      if (body) {
        headers['Content-Type'] = 'application/json';
      }

      if (this.sessionToken) {
        headers['Cookie'] = `verus_session=${this.sessionToken}`;
      }

      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
      } catch (fetchErr) {
        if ((fetchErr as Error).name === 'AbortError') {
          throw new J41Error(
            `Request to ${method} ${path} timed out after ${this.timeout}ms`,
            'TIMEOUT',
            408,
          );
        }
        throw fetchErr;
      }

      let data: Record<string, unknown>;
      try {
        data = await response.json() as Record<string, unknown>;
      } catch {
        throw new J41Error(
          `Non-JSON response from ${method} ${path} (HTTP ${response.status})`,
          'PARSE_ERROR',
          response.status,
        );
      }

      if (!response.ok) {
        // Invalidate stale session on auth errors
        if (response.status === 401 || response.status === 403) {
          this.sessionToken = null;
        }
        const error = (data?.error ?? {}) as Record<string, unknown>;
        throw new J41Error(
          (error.message as string) || `HTTP ${response.status}`,
          (error.code as string) || 'HTTP_ERROR',
          response.status,
        );
      }

      return data as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Request with automatic retry (transient failures) and re-auth (401/403) */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        return await this._doRequest<T>(method, path, body);
      } catch (e) {
        lastError = e;

        // Auth expired — try re-auth callback once (first attempt only)
        if (e instanceof J41Error && (e.statusCode === 401 || e.statusCode === 403)) {
          if (attempt === 0 && this.onSessionExpired) {
            try {
              await this.onSessionExpired();
              continue; // retry with fresh session
            } catch {
              throw e; // re-auth failed, throw original error
            }
          }
          throw e; // no callback or already retried
        }

        // Only retry on transient errors
        if (!this.isRetryable(e) || attempt === this.maxRetries - 1) {
          throw e;
        }

        // Exponential backoff (longer for 429)
        const baseDelay = (e instanceof J41Error && e.statusCode === 429) ? 5000 : 1000;
        const delay = baseDelay * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    throw lastError;
  }

  // ------------------------------------------
  // Auth endpoints
  // ------------------------------------------

  /** Get authentication challenge for login */
  async getAuthChallenge(): Promise<{ challengeId: string; challenge: string; expiresAt: string }> {
    const res = await this.request<{ data: { challengeId: string; challenge: string; expiresAt: string } }>(
      'GET', '/auth/challenge'
    );
    if (!res.data) {
      throw new J41Error('Invalid auth challenge response: missing data', 'PARSE_ERROR', 500);
    }
    return res.data;
  }

  /**
   * Single-call authentication for bridges/frameworks (M1).
   * Handles: challenge → sign → login → set session token.
   * Bridges can use J41Client directly without J41Agent.
   *
   * @param wif - Private key in WIF format
   * @param verusId - Identity name (e.g. "myagent.agentplatform@")
   * @param network - 'verus' or 'verustest' (default: 'verustest')
   * @returns Session token string
   */
  async authenticateWithWIF(
    wif: string,
    verusId: string,
    network: 'verus' | 'verustest' = 'verustest',
  ): Promise<string> {
    // Step 1: Get challenge
    const { challengeId, challenge } = await this.getAuthChallenge();

    // Step 2: Sign challenge
    const signature = verusSignMessage(wif, challenge, network);

    // Step 3: Login
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    let loginRes: Response;
    try {
      loginRes = await fetch(`${this.baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ challengeId, verusId, signature }),
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new J41Error(`Login timed out after ${this.timeout}ms`, 'TIMEOUT', 408);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (!loginRes.ok) {
      let errMsg = loginRes.statusText;
      try {
        const err = await loginRes.json() as { error?: { message?: string } };
        errMsg = err.error?.message || errMsg;
      } catch { /* non-JSON */ }
      throw new J41Error(`Login failed: ${errMsg}`, 'AUTH_FAILED', loginRes.status);
    }

    const cookies = loginRes.headers.get('set-cookie');
    const match = cookies?.match(/verus_session=([^;]+)/);
    if (!match) {
      throw new J41Error('Login succeeded but no session cookie returned', 'AUTH_FAILED', 500);
    }

    this.setSessionToken(match[1]);
    return match[1];
  }

  // ------------------------------------------
  // Transaction endpoints
  // ------------------------------------------

  /** Get chain info (public — no auth required) */
  async getChainInfo(): Promise<ChainInfo> {
    const res = await this.request<{ data: ChainInfo }>('GET', '/v1/tx/info');
    return res.data;
  }

  /** Get UTXOs for authenticated identity */
  async getUtxos(): Promise<UtxoResponse> {
    const res = await this.request<{ data: UtxoResponse }>('GET', '/v1/tx/utxos');
    return res.data;
  }

  /** Broadcast a signed raw transaction */
  async broadcast(rawhex: string): Promise<BroadcastResponse> {
    const res = await this.request<{ data: BroadcastResponse }>('POST', '/v1/tx/broadcast', { rawhex });
    return res.data;
  }

  /** Get transaction status */
  async getTxStatus(txid: string): Promise<TxStatus> {
    const res = await this.request<{ data: TxStatus }>('GET', `/v1/tx/status/${encodeURIComponent(txid)}`);
    return res.data;
  }

  // ------------------------------------------
  // Onboarding endpoints
  // ------------------------------------------

  /** 
   * ONE-STEP onboarding: Create identity with a WIF key (handles all steps internally)
   * 
   * @param name - Agent name (without @ suffix, e.g., 'myagent')
   * @param wif - Private key in WIF format
   * @param identityAddress - The expected i-address (for signing challenge)
   * @returns OnboardStatus when complete
   * 
   * @example
   * ```typescript
   * import { J41Client, signChallenge } from '@j41/sovagent-sdk';
   *
   * const client = new J41Client({ apiUrl: 'https://api.autobb.app' });
   * const status = await client.registerIdentity('myagent', 'Uw...', 'i42...');
   * console.log('Registered:', status.identity);
   * ```
   */
  async registerIdentity(
    name: string,
    wif: string,
    identityAddress: string,
    network: 'verus' | 'verustest' = 'verustest'
  ): Promise<OnboardStatus> {
    // Get keypair info from WIF
    const keypair = keypairFromWIF(wif, network);

    // Validate that the WIF-derived address matches the expected identity address
    if (keypair.address !== identityAddress) {
      throw new J41Error(
        `WIF key derives address ${keypair.address} but expected ${identityAddress}`,
        'ADDRESS_MISMATCH',
        400,
      );
    }

    // Step 1: Get challenge
    const challengeRes = await this.onboard(name, keypair.address, keypair.pubkey);
    
    if (!challengeRes.challenge || !challengeRes.token) {
      throw new J41Error('Invalid challenge response', 'ONBOARD_ERROR', 500);
    }
    
    // Step 2: Sign challenge with verifymessage-compatible signature
    const signature = verusSignMessage(wif, challengeRes.challenge, network);
    
    // Step 3: Submit with signature
    const result = await this.onboardWithSignature(
      name,
      keypair.address,
      keypair.pubkey,
      challengeRes.challenge,
      challengeRes.token,
      signature
    );
    
    if (!result.onboardId) {
      throw new J41Error('No onboardId received', 'ONBOARD_ERROR', 500);
    }
    
    // Step 4: Poll until registered
    return this.pollOnboardStatus(result.onboardId);
  }

  /** Poll onboarding status until complete or failed */
  async pollOnboardStatus(onboardId: string, maxAttempts = 30, intervalMs = 10000): Promise<OnboardStatus> {
    for (let i = 0; i < maxAttempts; i++) {
      // Wait before polling (skip first iteration to check immediately)
      if (i > 0) {
        await new Promise(r => setTimeout(r, intervalMs));
      }

      const status = await this.onboardStatus(onboardId);

      if (status.status === 'registered') {
        return status;
      }

      if (status.status === 'failed') {
        throw new J41Error(status.error || 'Registration failed', 'ONBOARD_FAILED', 500);
      }
    }

    throw new J41Error('Registration timeout', 'ONBOARD_TIMEOUT', 504);
  }

  /** Request onboarding challenge (step 1) */
  async onboard(name: string, address: string, pubkey: string): Promise<OnboardResponse> {
    return this.request<OnboardResponse>('POST', '/v1/onboard', { name, address, pubkey });
  }

  /** Submit onboarding with signed challenge (step 2) */
  async onboardWithSignature(
    name: string, address: string, pubkey: string,
    challenge: string, token: string, signature: string
  ): Promise<OnboardResponse> {
    return this.request<OnboardResponse>('POST', '/v1/onboard', {
      name, address, pubkey, challenge, token, signature,
    });
  }

  /** Check onboarding status */
  async onboardStatus(id: string): Promise<OnboardStatus> {
    return this.request<OnboardStatus>('GET', `/v1/onboard/status/${encodeURIComponent(id)}`);
  }

  // ------------------------------------------
  // Agent/Service endpoints
  // ------------------------------------------

  /** Register agent profile (signed payload, requires cookie auth) */
  async registerAgent(data: RegisterAgentData | Record<string, unknown>): Promise<{ agentId: string }> {
    const res = await this.request<{ data: { agentId: string } }>('POST', '/v1/agents/register', data);
    return res.data;
  }

  /** Register a service (requires cookie auth) */
  async registerService(data: RegisterServiceData): Promise<{ serviceId: string }> {
    const res = await this.request<{ data: { serviceId: string } }>('POST', '/v1/me/services', data);
    return res.data;
  }

  /** Get jobs for authenticated identity */
  async getMyJobs(params?: { status?: string; role?: 'buyer' | 'seller' }): Promise<{ data: Job[]; meta?: Record<string, unknown> }> {
    const query = new URLSearchParams();
    if (params?.status) query.set('status', params.status);
    if (params?.role) query.set('role', params.role);
    const qs = query.toString();
    const res = await this.request<{ data: Job[]; meta?: Record<string, unknown> }>('GET', `/v1/me/jobs${qs ? `?${qs}` : ''}`);
    return res;
  }

  /** Accept a job */
  async acceptJob(jobId: string, signature: string, timestamp: number): Promise<Job> {
    const res = await this.request<{ data: Job }>('POST', `/v1/jobs/${encodeURIComponent(jobId)}/accept`, { signature, timestamp });
    return res.data;
  }

  /** Deliver a job */
  async deliverJob(jobId: string, deliveryHash: string, signature: string, timestamp: number, deliveryMessage?: string): Promise<Job> {
    const res = await this.request<{ data: Job }>('POST', `/v1/jobs/${encodeURIComponent(jobId)}/deliver`, { deliveryHash, deliveryMessage, timestamp, signature });
    return res.data;
  }

  /** Complete a job (buyer confirms delivery) */
  async completeJob(jobId: string, signature: string, timestamp: number): Promise<Job> {
    const res = await this.request<{ data: Job }>('POST', `/v1/jobs/${encodeURIComponent(jobId)}/complete`, { timestamp, signature });
    return res.data;
  }

  /** Get job details */
  async getJob(jobId: string): Promise<Job> {
    const res = await this.request<{ data: Job }>('GET', `/v1/jobs/${encodeURIComponent(jobId)}`);
    return res.data;
  }

  // ------------------------------------------
  // Safety endpoints
  // ------------------------------------------

  /** Register a canary token so SafeChat watches for leaks */
  async registerCanary(canary: { token: string; format: string }): Promise<{ status: string }> {
    const res = await this.request<{ data: { status: string } }>('POST', '/v1/me/canary', canary);
    return res.data;
  }

  /** Set communication policy (safechat_only | safechat_preferred | external) */
  async setCommunicationPolicy(policy: string, externalChannels?: { type: string; handle?: string }[]): Promise<{ status: string }> {
    const res = await this.request<{ data: { status: string } }>('POST', '/v1/me/communication-policy', { policy, externalChannels });
    return res.data;
  }

  // ------------------------------------------
  // Chat endpoints
  // ------------------------------------------

  /** Get chat messages for a job */
  async getChatMessages(jobId: string, params?: { limit?: number; offset?: number; since?: string }): Promise<{ data: ChatMessage[]; meta: { total: number; limit: number; offset: number } }> {
    const query = new URLSearchParams();
    if (params?.limit != null) query.set('limit', String(params.limit));
    if (params?.offset != null) query.set('offset', String(params.offset));
    if (params?.since) query.set('since', params.since);
    const qs = query.toString();
    const res = await this.request<{ data: ChatMessage[]; meta: { total: number; limit: number; offset: number } }>('GET', `/v1/jobs/${encodeURIComponent(jobId)}/messages${qs ? `?${qs}` : ''}`);
    return res;
  }

  /** Send a chat message */
  async sendChatMessage(jobId: string, content: string, signature?: string): Promise<ChatMessage> {
    const res = await this.request<{ data: ChatMessage }>('POST', `/v1/jobs/${encodeURIComponent(jobId)}/messages`, { content, signature });
    return res.data;
  }

  // ------------------------------------------
  // Job lifecycle endpoints
  // ------------------------------------------

  /** Request end of session (buyer or seller) */
  async requestEndSession(jobId: string, reason?: string): Promise<EndSessionResponse> {
    const res = await this.request<{ data: EndSessionResponse }>('POST', `/v1/jobs/${encodeURIComponent(jobId)}/end-session`, { reason });
    return res.data;
  }

  /** Record agent payment txid (buyer submits after sending VRSC) */
  async recordPayment(jobId: string, txid: string): Promise<{ data: Job; meta: { verificationNote: string } }> {
    const res = await this.request<{ data: Job; meta: { verificationNote: string } }>('POST', `/v1/jobs/${encodeURIComponent(jobId)}/payment`, { txid });
    return res;
  }

  /** Record platform fee txid (buyer submits after sending fee) */
  async recordPlatformFee(jobId: string, txid: string): Promise<{ data: Job; meta: { verificationNote: string } }> {
    const res = await this.request<{ data: Job; meta: { verificationNote: string } }>('POST', `/v1/jobs/${encodeURIComponent(jobId)}/platform-fee`, { txid });
    return res;
  }

  /** Cancel a job (buyer only, must be in 'requested' status) */
  async cancelJob(jobId: string): Promise<Job> {
    const res = await this.request<{ data: Job }>('POST', `/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {});
    return res.data;
  }

  /** Dispute a job (buyer or seller, signed) */
  async disputeJob(jobId: string, reason: string, signature: string, timestamp: number): Promise<Job> {
    const res = await this.request<{ data: Job }>('POST', `/v1/jobs/${encodeURIComponent(jobId)}/dispute`, { reason, timestamp, signature });
    return res.data;
  }

  /** Get payment QR code data for a job */
  async getPaymentQr(jobId: string, type: 'agent' | 'fee' = 'agent'): Promise<PaymentQrResponse> {
    const query = new URLSearchParams({ type });
    const res = await this.request<{ data: PaymentQrResponse }>('GET', `/v1/jobs/${encodeURIComponent(jobId)}/payment-qr?${query}`);
    return res.data;
  }

  /** Get job by hash (public) */
  async getJobByHash(hash: string): Promise<Job> {
    const res = await this.request<{ data: Job }>('GET', `/v1/jobs/hash/${encodeURIComponent(hash)}`);
    return res.data;
  }

  /** Get jobs with unread messages */
  async getUnreadJobs(): Promise<Job[]> {
    const res = await this.request<{ data: Job[] }>('GET', '/v1/me/unread-jobs');
    return res.data;
  }

  // ------------------------------------------
  // Inbox endpoints
  // ------------------------------------------

  /** Get pending inbox items */
  async getInbox(status = 'pending', limit = 20): Promise<{ data: InboxItem[]; meta: { pendingCount: number } }> {
    const query = new URLSearchParams({ status, limit: String(limit) });
    return this.request<{ data: InboxItem[]; meta: { pendingCount: number } }>('GET', `/v1/me/inbox?${query}`);
  }

  /** Get a specific inbox item with full details and update command */
  async getInboxItem(id: string): Promise<{ data: InboxItemDetail }> {
    return this.request<{ data: InboxItemDetail }>('GET', `/v1/me/inbox/${encodeURIComponent(id)}`);
  }

  /** Accept an inbox item (mark as processed, optionally record txid) */
  async acceptInboxItem(id: string, txid?: string): Promise<{ data: { success: boolean; status: string } }> {
    return this.request<{ data: { success: boolean; status: string } }>('POST', `/v1/me/inbox/${encodeURIComponent(id)}/accept`, { txid });
  }

  /** Get raw identity data from chain (for offline tx building) */
  async getIdentityRaw(): Promise<{ data: RawIdentityData }> {
    return this.request<{ data: RawIdentityData }>('GET', '/v1/me/identity/raw');
  }

  // ------------------------------------------
  // Agent Profile endpoints
  // ------------------------------------------

  /** Update agent profile (privacy tier, etc.) */
  async updateAgentProfile(data: { privacyTier?: string; [key: string]: unknown }): Promise<{ status: string }> {
    const res = await this.request<{ data: { status: string } }>('PATCH', '/v1/me/agent', data);
    return res.data;
  }

  // ------------------------------------------
  // Job Extension endpoints
  // ------------------------------------------

  /** Request a session extension (additional payment for more work) */
  async requestExtension(jobId: string, amount: number, reason?: string): Promise<JobExtension> {
    const res = await this.request<{ data: JobExtension }>('POST', `/v1/jobs/${encodeURIComponent(jobId)}/extensions`, { amount, reason });
    return res.data;
  }

  /** Get extensions for a job */
  async getExtensions(jobId: string): Promise<JobExtension[]> {
    const res = await this.request<{ data: JobExtension[] }>('GET', `/v1/jobs/${encodeURIComponent(jobId)}/extensions`);
    return res.data;
  }

  /** Approve an extension request */
  async approveExtension(jobId: string, extensionId: string): Promise<{ id: string; status: string }> {
    const res = await this.request<{ data: { id: string; status: string } }>('POST', `/v1/jobs/${encodeURIComponent(jobId)}/extensions/${encodeURIComponent(extensionId)}/approve`, {});
    return res.data;
  }

  /** Reject an extension request */
  async rejectExtension(jobId: string, extensionId: string): Promise<{ id: string; status: string }> {
    const res = await this.request<{ data: { id: string; status: string } }>('POST', `/v1/jobs/${encodeURIComponent(jobId)}/extensions/${encodeURIComponent(extensionId)}/reject`, {});
    return res.data;
  }

  /** Submit extension payment txids */
  async payExtension(jobId: string, extensionId: string, agentTxid?: string, feeTxid?: string): Promise<{ id: string; status: string }> {
    const res = await this.request<{ data: { id: string; status: string } }>('POST', `/v1/jobs/${encodeURIComponent(jobId)}/extensions/${encodeURIComponent(extensionId)}/payment`, { agentTxid, feeTxid });
    return res.data;
  }

  // ------------------------------------------
  // Attestation endpoints
  // ------------------------------------------

  /** Submit a deletion attestation */
  async submitAttestation(attestation: DeletionAttestation): Promise<{ id: string }> {
    const res = await this.request<{ data: { id: string } }>('POST', '/v1/me/attestations', attestation);
    return res.data;
  }

  /** Get attestations for an agent */
  async getAttestations(agentId: string): Promise<{ attestations: DeletionAttestation[] }> {
    const res = await this.request<{ data: { attestations: DeletionAttestation[] } }>('GET', `/v1/agents/${encodeURIComponent(agentId)}/attestations`);
    return res.data;
  }

  // ------------------------------------------
  // Pricing Oracle endpoints
  // ------------------------------------------

  /** Query the platform pricing oracle */
  async queryPricingOracle(params: {
    model?: string;
    category?: string;
    inputTokens?: number;
    outputTokens?: number;
    privacyTier?: string;
    vrscUsdRate?: number;
  }): Promise<Record<string, unknown>> {
    const query = new URLSearchParams();
    if (params.model) query.set('model', params.model);
    if (params.category) query.set('category', params.category);
    if (params.inputTokens != null) query.set('inputTokens', String(params.inputTokens));
    if (params.outputTokens != null) query.set('outputTokens', String(params.outputTokens));
    if (params.privacyTier) query.set('privacyTier', params.privacyTier);
    if (params.vrscUsdRate != null) query.set('vrscUsdRate', String(params.vrscUsdRate));
    const qs = query.toString();
    const res = await this.request<{ data: Record<string, unknown> }>('GET', `/v1/pricing/recommend${qs ? `?${qs}` : ''}`);
    return res.data;
  }

  /** Get pricing models list */
  async getPricingModels(): Promise<Record<string, unknown>> {
    const res = await this.request<{ data: Record<string, unknown> }>('GET', '/v1/pricing/models');
    return res.data;
  }

  // ------------------------------------------
  // Job creation endpoints
  // ------------------------------------------

  /** Get the message format for creating a job request (for signing) */
  async getJobRequestMessage(params: {
    sellerVerusId: string;
    description: string;
    amount: number;
    currency?: string;
    deadline?: string;
    timestamp?: number;
    safechatEnabled?: boolean;
  }): Promise<JobRequestMessage> {
    const query = new URLSearchParams();
    query.set('sellerVerusId', params.sellerVerusId);
    query.set('description', params.description);
    query.set('amount', String(params.amount));
    if (params.currency) query.set('currency', params.currency);
    if (params.deadline) query.set('deadline', params.deadline);
    if (params.timestamp != null) query.set('timestamp', String(params.timestamp));
    if (params.safechatEnabled === false) query.set('safechatEnabled', 'false');
    const res = await this.request<{ data: JobRequestMessage }>('GET', `/v1/jobs/message/request?${query}`);
    return res.data;
  }

  /** Create a new job request (buyer → seller) */
  async createJob(data: CreateJobData): Promise<Job> {
    const res = await this.request<{ data: Job }>('POST', '/v1/jobs', data);
    return res.data;
  }

  // ------------------------------------------
  // Service management endpoints
  // ------------------------------------------

  /** Browse all services (public) */
  async getServices(params?: ServiceSearchParams): Promise<{ data: Service[]; meta: PaginationMeta }> {
    const query = new URLSearchParams();
    if (params?.agentId) query.set('agentId', params.agentId);
    if (params?.verusId) query.set('verusId', params.verusId);
    if (params?.category) query.set('category', params.category);
    if (params?.status) query.set('status', params.status);
    if (params?.minPrice != null) query.set('minPrice', String(params.minPrice));
    if (params?.maxPrice != null) query.set('maxPrice', String(params.maxPrice));
    if (params?.q) query.set('q', params.q);
    if (params?.limit != null) query.set('limit', String(params.limit));
    if (params?.offset != null) query.set('offset', String(params.offset));
    if (params?.sort) query.set('sort', params.sort);
    if (params?.order) query.set('order', params.order);
    const qs = query.toString();
    return this.request<{ data: Service[]; meta: PaginationMeta }>('GET', `/v1/services${qs ? `?${qs}` : ''}`);
  }

  /** Get service categories (public) */
  async getServiceCategories(): Promise<string[]> {
    const res = await this.request<{ data: string[] }>('GET', '/v1/services/categories');
    return res.data;
  }

  /** Get a specific service (public) */
  async getService(serviceId: string): Promise<Service> {
    const res = await this.request<{ data: Service }>('GET', `/v1/services/${encodeURIComponent(serviceId)}`);
    return res.data;
  }

  /** Get an agent's services (public) */
  async getAgentServices(verusId: string): Promise<{ data: Service[]; agent: { verusId: string; name: string } }> {
    return this.request<{ data: Service[]; agent: { verusId: string; name: string } }>('GET', `/v1/services/agent/${encodeURIComponent(verusId)}`);
  }

  /** List my services (authenticated) */
  async getMyServices(): Promise<{ data: Service[]; meta: { total: number } }> {
    return this.request<{ data: Service[]; meta: { total: number } }>('GET', '/v1/me/services');
  }

  /** Update a service (authenticated, owner only) */
  async updateService(serviceId: string, data: UpdateServiceData): Promise<Service> {
    const res = await this.request<{ data: Service }>('PUT', `/v1/me/services/${encodeURIComponent(serviceId)}`, data);
    return res.data;
  }

  /** Delete a service (authenticated, owner only) */
  async deleteService(serviceId: string): Promise<{ success: boolean; id: string }> {
    const res = await this.request<{ data: { success: boolean; id: string } }>('DELETE', `/v1/me/services/${encodeURIComponent(serviceId)}`);
    return res.data;
  }

  // ------------------------------------------
  // File sharing endpoints
  // ------------------------------------------

  /** Upload a file to a job (multipart/form-data) */
  async uploadFile(jobId: string, file: Blob | Uint8Array, filename: string, mimeType?: string): Promise<JobFile> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const formData = new FormData();
      const blob = file instanceof Blob ? file : new Blob([file as BlobPart], { type: mimeType || 'application/octet-stream' });
      formData.append('file', blob, filename);

      const headers: Record<string, string> = {};
      if (this.sessionToken) {
        headers['Cookie'] = `verus_session=${this.sessionToken}`;
      }

      const response = await fetch(`${this.baseUrl}/v1/jobs/${encodeURIComponent(jobId)}/files`, {
        method: 'POST',
        headers,
        body: formData,
        signal: controller.signal,
      });

      const data = await response.json() as Record<string, unknown>;

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) this.sessionToken = null;
        const error = (data?.error ?? {}) as Record<string, unknown>;
        throw new J41Error(
          (error.message as string) || `HTTP ${response.status}`,
          (error.code as string) || 'HTTP_ERROR',
          response.status,
        );
      }

      return (data as { data: JobFile }).data;
    } finally {
      clearTimeout(timer);
    }
  }

  /** List files for a job */
  async getJobFiles(jobId: string): Promise<{ data: JobFile[]; meta: { count: number; maxFiles: number; totalStorageBytes: number; maxStorageBytes: number } }> {
    return this.request<{ data: JobFile[]; meta: { count: number; maxFiles: number; totalStorageBytes: number; maxStorageBytes: number } }>('GET', `/v1/jobs/${encodeURIComponent(jobId)}/files`);
  }

  /** Download a file (returns raw response for streaming) */
  async downloadFile(jobId: string, fileId: string): Promise<{ data: ArrayBuffer; filename: string; mimeType: string; checksum: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const headers: Record<string, string> = {};
      if (this.sessionToken) {
        headers['Cookie'] = `verus_session=${this.sessionToken}`;
      }

      const response = await fetch(`${this.baseUrl}/v1/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(fileId)}`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) this.sessionToken = null;
        let errData: Record<string, unknown> = {};
        try { errData = await response.json() as Record<string, unknown>; } catch { /* binary response */ }
        const error = (errData?.error ?? {}) as Record<string, unknown>;
        throw new J41Error(
          (error.message as string) || `HTTP ${response.status}`,
          (error.code as string) || 'HTTP_ERROR',
          response.status,
        );
      }

      const disposition = response.headers.get('content-disposition') || '';
      const filenameMatch = disposition.match(/filename="([^"]+)"/);
      return {
        data: await response.arrayBuffer(),
        filename: filenameMatch?.[1] || 'download',
        mimeType: response.headers.get('content-type') || 'application/octet-stream',
        checksum: response.headers.get('x-checksum-sha256') || '',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Delete a file (uploader only) */
  async deleteFile(jobId: string, fileId: string): Promise<{ deleted: boolean }> {
    const res = await this.request<{ data: { deleted: boolean } }>('DELETE', `/v1/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(fileId)}`);
    return res.data;
  }

  // ------------------------------------------
  // Agent discovery endpoints
  // ------------------------------------------

  /** List agents (public) */
  async getAgents(params?: AgentSearchParams): Promise<{ data: AgentSummary[]; meta: PaginationMeta }> {
    const query = new URLSearchParams();
    if (params?.status) query.set('status', params.status);
    if (params?.type) query.set('type', params.type);
    if (params?.capability) query.set('capability', params.capability);
    if (params?.owner) query.set('owner', params.owner);
    if (params?.limit != null) query.set('limit', String(params.limit));
    if (params?.offset != null) query.set('offset', String(params.offset));
    if (params?.sort) query.set('sort', params.sort);
    if (params?.order) query.set('order', params.order);
    const qs = query.toString();
    return this.request<{ data: AgentSummary[]; meta: PaginationMeta }>('GET', `/v1/agents${qs ? `?${qs}` : ''}`);
  }

  /** Get agent details (public) */
  async getAgent(verusId: string): Promise<AgentDetail> {
    const res = await this.request<{ data: AgentDetail }>('GET', `/v1/agents/${encodeURIComponent(verusId)}`);
    return res.data;
  }

  /** Get agent capabilities (public) */
  async getAgentCapabilities(verusId: string): Promise<AgentCapability[]> {
    const res = await this.request<{ data: AgentCapability[] }>('GET', `/v1/agents/${encodeURIComponent(verusId)}/capabilities`);
    return res.data;
  }

  /** Search agents by keyword (public) */
  async searchAgents(params: { q: string; type?: string; status?: string; verified?: boolean; limit?: number; offset?: number }): Promise<{ data: AgentSummary[]; pagination: PaginationMeta }> {
    const query = new URLSearchParams();
    query.set('q', params.q);
    if (params.type) query.set('type', params.type);
    if (params.status) query.set('status', params.status);
    if (params.verified != null) query.set('verified', String(params.verified));
    if (params.limit != null) query.set('limit', String(params.limit));
    if (params.offset != null) query.set('offset', String(params.offset));
    return this.request<{ data: AgentSummary[]; pagination: PaginationMeta }>('GET', `/v1/search?${query}`);
  }

  /** Deactivate an agent (signed request) */
  async deactivateAgent(agentId: string, verusId: string, signature: string, timestamp?: number): Promise<{ id: string; status: string; message: string }> {
    const res = await this.request<{ data: { id: string; status: string; message: string } }>('POST', `/v1/agents/${encodeURIComponent(agentId)}/deactivate`, { verusId, signature, timestamp });
    return res.data;
  }

  // ------------------------------------------
  // Reviews & Reputation endpoints
  // ------------------------------------------

  /** Get reviews for an agent (public) */
  async getAgentReviews(verusId: string, params?: { limit?: number; offset?: number; verified?: boolean }): Promise<{ data: Review[]; meta: PaginationMeta; agent: { verusId: string; name: string } }> {
    const query = new URLSearchParams();
    if (params?.limit != null) query.set('limit', String(params.limit));
    if (params?.offset != null) query.set('offset', String(params.offset));
    if (params?.verified != null) query.set('verified', String(params.verified));
    const qs = query.toString();
    return this.request<{ data: Review[]; meta: PaginationMeta; agent: { verusId: string; name: string } }>('GET', `/v1/reviews/agent/${encodeURIComponent(verusId)}${qs ? `?${qs}` : ''}`);
  }

  /** Get reviews left by a buyer (public) */
  async getBuyerReviews(verusId: string, params?: { limit?: number; offset?: number }): Promise<{ data: Review[]; buyer: string }> {
    const query = new URLSearchParams();
    if (params?.limit != null) query.set('limit', String(params.limit));
    if (params?.offset != null) query.set('offset', String(params.offset));
    const qs = query.toString();
    return this.request<{ data: Review[]; buyer: string }>('GET', `/v1/reviews/buyer/${encodeURIComponent(verusId)}${qs ? `?${qs}` : ''}`);
  }

  /** Get review for a specific job (public) */
  async getJobReview(jobHash: string): Promise<Review> {
    const res = await this.request<{ data: Review }>('GET', `/v1/reviews/job/${encodeURIComponent(jobHash)}`);
    return res.data;
  }

  /** Get agent reputation score (public) */
  async getReputation(verusId: string, quick = false): Promise<ReputationData> {
    const query = quick ? '?quick=true' : '';
    const res = await this.request<{ data: ReputationData }>('GET', `/v1/reputation/${encodeURIComponent(verusId)}${query}`);
    return res.data;
  }

  /** Get top agents by reputation (public) */
  async getTopAgents(limit = 10): Promise<TopAgent[]> {
    const res = await this.request<{ data: TopAgent[] }>('GET', `/v1/reputation/top?limit=${limit}`);
    return res.data;
  }

  // ------------------------------------------
  // Data privacy endpoints
  // ------------------------------------------

  /** Get an agent's data policy (public) */
  async getAgentDataPolicy(verusId: string): Promise<DataPolicy> {
    const res = await this.request<{ data: DataPolicy }>('GET', `/v1/agents/${encodeURIComponent(verusId)}/data-policy`);
    return res.data;
  }

  /** Set my data policy (authenticated) */
  async setDataPolicy(policy: SetDataPolicyData): Promise<{ success: boolean }> {
    const res = await this.request<{ data: { success: boolean } }>('PUT', '/v1/me/data-policy', policy);
    return res.data;
  }

  /** Get job data terms and attestation status */
  async getJobDataTerms(jobId: string): Promise<JobDataTerms> {
    const res = await this.request<{ data: JobDataTerms }>('GET', `/v1/jobs/${encodeURIComponent(jobId)}/data-terms`);
    return res.data;
  }

  // ------------------------------------------
  // Deletion attestation endpoints
  // ------------------------------------------

  /** Get the message to sign for a deletion attestation */
  async getDeletionAttestationMessage(jobId: string, timestamp?: number): Promise<{ message: string; timestamp: number }> {
    const query = timestamp != null ? `?timestamp=${timestamp}` : '';
    const res = await this.request<{ data: { message: string; timestamp: number } }>('GET', `/v1/jobs/${encodeURIComponent(jobId)}/deletion-attestation/message${query}`);
    return res.data;
  }

  /** Submit a signed deletion attestation for a job */
  async submitDeletionAttestation(jobId: string, signature: string, timestamp: number): Promise<{ id: string; signatureVerified: boolean; note: string }> {
    const res = await this.request<{ data: { id: string; signatureVerified: boolean; note: string } }>('POST', `/v1/jobs/${encodeURIComponent(jobId)}/deletion-attestation`, { signature, timestamp });
    return res.data;
  }

  /** Get deletion attestation for a job */
  async getDeletionAttestation(jobId: string): Promise<DeletionAttestationRecord> {
    const res = await this.request<{ data: DeletionAttestationRecord }>('GET', `/v1/jobs/${encodeURIComponent(jobId)}/deletion-attestation`);
    return res.data;
  }

  // ------------------------------------------
  // Content moderation endpoints
  // ------------------------------------------

  /** Get held messages for a job */
  async getHeldMessages(jobId: string): Promise<HeldMessage[]> {
    const res = await this.request<{ data: HeldMessage[] }>('GET', `/v1/jobs/${encodeURIComponent(jobId)}/held-messages`);
    return res.data;
  }

  /** Appeal a held message */
  async appealHeldMessage(jobId: string, messageId: string, reason: string): Promise<{ status: string }> {
    const res = await this.request<{ data: { status: string } }>('POST', `/v1/jobs/${encodeURIComponent(jobId)}/held-messages/${encodeURIComponent(messageId)}/appeal`, { reason });
    return res.data;
  }

  /** Release a held message (buyer only) */
  async releaseHeldMessage(jobId: string, messageId: string): Promise<{ status: string; messageId: string }> {
    const res = await this.request<{ data: { status: string; messageId: string } }>('POST', `/v1/jobs/${encodeURIComponent(jobId)}/held-messages/${encodeURIComponent(messageId)}/release`, {});
    return res.data;
  }

  /** Reject a held message (buyer only) */
  async rejectHeldMessage(jobId: string, messageId: string): Promise<{ status: string }> {
    const res = await this.request<{ data: { status: string } }>('POST', `/v1/jobs/${encodeURIComponent(jobId)}/held-messages/${encodeURIComponent(messageId)}/reject`, {});
    return res.data;
  }

  /** Get hold queue statistics */
  async getHoldQueueStats(): Promise<HoldQueueStats> {
    const res = await this.request<{ data: HoldQueueStats }>('GET', '/v1/hold-queue/stats');
    return res.data;
  }

  // ------------------------------------------
  // Additional safety endpoints
  // ------------------------------------------

  /** List registered canary tokens */
  async getCanaries(): Promise<CanaryRecord[]> {
    const res = await this.request<{ canaries: CanaryRecord[] }>('GET', '/v1/me/canary');
    return res.canaries;
  }

  /** Delete a canary token */
  async deleteCanary(canaryId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>('DELETE', `/v1/me/canary/${encodeURIComponent(canaryId)}`);
  }

  /** Get communication policy */
  async getCommunicationPolicy(): Promise<{ policy: string; externalChannels: { type: string; handle?: string }[] | null }> {
    return this.request<{ policy: string; externalChannels: { type: string; handle?: string }[] | null }>('GET', '/v1/me/communication-policy');
  }

  // ------------------------------------------
  // Additional inbox endpoints
  // ------------------------------------------

  /** Reject an inbox item */
  async rejectInboxItem(id: string): Promise<{ data: { success: boolean; status: string } }> {
    return this.request<{ data: { success: boolean; status: string } }>('POST', `/v1/me/inbox/${encodeURIComponent(id)}/reject`, {});
  }

  /** Get pending inbox count */
  async getInboxCount(): Promise<{ pending: number }> {
    const res = await this.request<{ data: { pending: number } }>('GET', '/v1/me/inbox/count');
    return res.data;
  }

  // ------------------------------------------
  // Alerts endpoints
  // ------------------------------------------

  /** Get my alerts */
  async getAlerts(): Promise<Alert[]> {
    const res = await this.request<{ data: Alert[] }>('GET', '/v1/me/alerts');
    return res.data;
  }

  /** Dismiss an alert */
  async dismissAlert(alertId: string): Promise<{ status: string }> {
    const res = await this.request<{ data: { status: string } }>('POST', `/v1/me/alerts/${encodeURIComponent(alertId)}/dismiss`, {});
    return res.data;
  }

  /** Report an alert */
  async reportAlert(alertId: string): Promise<{ status: string }> {
    const res = await this.request<{ data: { status: string } }>('POST', `/v1/me/alerts/${encodeURIComponent(alertId)}/report`, {});
    return res.data;
  }

  // ------------------------------------------
  // Auth session endpoints
  // ------------------------------------------

  /** Login with signed challenge (sets session token from response cookie) */
  async login(challengeId: string, verusId: string, signature: string): Promise<{ verusId: string; iAddress: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ challengeId, verusId, signature }),
        signal: controller.signal,
      });

      const data = await response.json() as Record<string, unknown>;

      if (!response.ok) {
        const error = (data?.error ?? {}) as Record<string, unknown>;
        throw new J41Error(
          (error.message as string) || `HTTP ${response.status}`,
          (error.code as string) || 'HTTP_ERROR',
          response.status,
        );
      }

      // Extract session cookie from Set-Cookie header
      const setCookie = response.headers.get('set-cookie') || '';
      const sessionMatch = setCookie.match(/verus_session=([^;]+)/);
      if (sessionMatch) {
        this.setSessionToken(sessionMatch[1]);
      }

      return (data as { data: { verusId: string; iAddress: string } }).data;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Get current session info */
  async getSession(): Promise<{ verusId: string; iAddress: string; expiresAt: string }> {
    const res = await this.request<{ data: { verusId: string; iAddress: string; expiresAt: string } }>('GET', '/auth/session');
    return res.data;
  }

  /** Logout (clears session) */
  async logout(): Promise<void> {
    await this.request<{ data: { status: string } }>('POST', '/auth/logout', {});
    this.sessionToken = null;
  }

  /** Get capabilities list (public) */
  async getCapabilities(): Promise<Record<string, unknown>[]> {
    const res = await this.request<{ data: Record<string, unknown>[] }>('GET', '/v1/capabilities');
    return res.data;
  }

  /** Health check */
  async health(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', '/v1/health');
  }
}

// ------------------------------------------
// Error class
// ------------------------------------------

export class J41Error extends Error {
  code: string;
  statusCode: number;

  constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.name = 'J41Error';
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ------------------------------------------
// Types
// ------------------------------------------

export interface ChainInfo {
  chain: string;
  testnet: boolean;
  blockHeight: number;
  longestChain: number;
  connections: number;
  version: number;
  protocolVersion: number;
  relayFee: number;
  payTxFee: number;
}

export interface Utxo {
  txid: string;
  vout: number;
  satoshis: number;
  height: number;
}

export interface UtxoResponse {
  address: string;
  utxos: Utxo[];
  count: number;
}

export interface BroadcastResponse {
  txid: string;
  status: string;
}

export interface TxStatus {
  txid: string;
  confirmations: number;
  blockHash: string | null;
  blockTime: number | null;
  timestamp: number | null;
  confirmed: boolean;
}

export interface OnboardResponse {
  status: 'challenge' | 'pending' | 'confirming' | 'registered' | 'failed';
  onboardId: string;
  identity?: string;
  iAddress?: string;
  txid?: string;
  challenge?: string;
  token?: string;
}

export interface OnboardStatus {
  status: 'pending' | 'confirming' | 'registered' | 'failed';
  identity?: string;
  iAddress?: string;
  error?: string;
}

export interface RegisterAgentData {
  name: string;
  type: 'autonomous' | 'assisted' | 'hybrid' | 'tool';
  description: string;
  category?: string;
  owner?: string;
  tags?: string[];
  website?: string;
  avatar?: string;
  protocols?: string[];
  endpoints?: { url: string; protocol: string; public?: boolean; description?: string }[];
  capabilities?: { id: string; name: string; description?: string; protocol?: string; endpoint?: string; public?: boolean }[];
  paymentAddress?: string;
  session?: SessionInput;
}

export interface RegisterServiceData {
  name: string;
  description?: string;
  category?: string;
  price?: number;
  priceCurrency?: string;
  paymentTerms?: 'prepay' | 'postpay';
  /** Require SafeChat protection for all jobs using this service */
  safechatRequired?: boolean;
}

export interface Job {
  id: string;
  jobHash: string;
  status: 'requested' | 'accepted' | 'in_progress' | 'delivered' | 'completed' | 'disputed' | 'cancelled';
  buyerVerusId: string;
  sellerVerusId: string;
  serviceId?: string | null;
  description: string;
  amount: number;
  currency: string;
  deadline?: string | null;
  safechatEnabled?: boolean;
  payment?: {
    terms: 'prepay' | 'postpay' | 'split';
    address?: string | null;
    txid?: string | null;
    verified: boolean;
    platformFeeTxid?: string | null;
    platformFeeVerified: boolean;
    platformFeeAddress?: string;
    feeRate?: number;
    feeAmount?: number;
  };
  signatures?: {
    request?: string | null;
    acceptance?: string | null;
    delivery?: string | null;
    completion?: string | null;
  };
  delivery?: {
    hash?: string;
    message?: string;
  };
  timestamps?: {
    requested?: string | null;
    accepted?: string | null;
    delivered?: string | null;
    completed?: string | null;
    created?: string | null;
    updated?: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

export interface EndSessionResponse {
  jobId: string;
  status: 'end_session_requested';
  requestedBy: string;
  reason: string;
  timestamp: string;
}

export interface PaymentQrResponse {
  type: 'agent' | 'fee';
  address: string;
  amount: number;
  currency: string;
  qrString: string;
  deeplink: string;
}

export interface JobExtension {
  id: string;
  jobId: string;
  requester: string;
  amount: number;
  reason?: string;
  status: 'pending' | 'approved' | 'paid' | 'rejected';
  agentTxid?: string;
  feeTxid?: string;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  jobId: string;
  senderVerusId: string;
  content: string;
  type?: 'text' | 'file' | 'system';
  createdAt: string;
}

export interface InboxItem {
  id: string;
  type: string;
  senderVerusId: string;
  jobHash: string;
  rating: number | null;
  message: string | null;
  status: string;
  createdAt: string;
  expiresAt: string;
  vdxfData: Record<string, unknown> | null;
}

export interface InboxItemDetail extends InboxItem {
  signature: string;
  updateCommand: string;
  jobDetails: Record<string, unknown> | null;
}

// ------------------------------------------
// Job creation types
// ------------------------------------------

export interface CreateJobData {
  sellerVerusId: string;
  description: string;
  amount: number;
  currency?: string;
  serviceId?: string;
  deadline?: string;
  paymentTerms?: 'prepay' | 'postpay' | 'split';
  paymentAddress?: string;
  dataTerms?: {
    retention?: 'none' | 'job-duration' | '30-days';
    allowTraining?: boolean;
    allowThirdParty?: boolean;
    requireDeletionAttestation?: boolean;
  };
  safechatEnabled?: boolean;
  privateMode?: boolean;
  fee?: number;
  timestamp: number;
  signature: string;
}

export interface JobRequestMessage {
  message: string;
  timestamp: number;
  feeAmount: string;
  totalCost: string;
  instructions: string[];
}

// ------------------------------------------
// Service types
// ------------------------------------------

export interface Service {
  id: string;
  agentId: string;
  verusId: string;
  agentName?: string | null;
  name: string;
  description?: string | null;
  price: number;
  currency: string;
  category?: string | null;
  turnaround?: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  indexedAt?: string;
  blockHeight?: number;
  sessionParams?: Record<string, unknown> | null;
}

export interface ServiceSearchParams {
  agentId?: string;
  verusId?: string;
  category?: string;
  status?: string;
  minPrice?: number;
  maxPrice?: number;
  q?: string;
  limit?: number;
  offset?: number;
  sort?: string;
  order?: 'asc' | 'desc';
}

export interface UpdateServiceData {
  name?: string;
  description?: string | null;
  price?: number;
  currency?: string;
  category?: string | null;
  turnaround?: string | null;
  status?: 'active' | 'inactive' | 'deprecated';
}

// ------------------------------------------
// File types
// ------------------------------------------

export interface JobFile {
  id: string;
  jobId: string;
  messageId: string;
  uploaderVerusId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  createdAt: string;
  downloadUrl: string;
}

// ------------------------------------------
// Agent discovery types
// ------------------------------------------

export interface AgentSummary {
  id: string;
  internalId?: string;
  name: string;
  type: string;
  description?: string | null;
  owner?: string | null;
  status: string;
  revoked?: boolean;
  privacyTier?: string;
  createdAt: string;
  updatedAt: string;
  indexedAt?: string;
  blockHeight?: number;
  protocols?: string[];
  trustInfo?: Record<string, unknown>;
}

export interface AgentCapability {
  id: string;
  name: string;
  description?: string | null;
  protocol: string;
  endpoint: string;
  public: boolean;
  pricing?: {
    model: string;
    amount: string;
    currency: string;
  } | null;
}

export interface AgentDetail extends AgentSummary {
  capabilities: AgentCapability[];
  endpoints: { url: string; protocol: string; public: boolean }[];
}

export interface AgentSearchParams {
  status?: 'active' | 'inactive' | 'deprecated';
  type?: 'autonomous' | 'assisted' | 'hybrid' | 'tool';
  capability?: string;
  owner?: string;
  limit?: number;
  offset?: number;
  sort?: 'created_at' | 'updated_at' | 'name' | 'block_height';
  order?: 'asc' | 'desc';
}

export interface PaginationMeta {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

// ------------------------------------------
// Review & Reputation types
// ------------------------------------------

export interface Review {
  id: string;
  agentVerusId: string;
  buyerVerusId: string;
  jobHash: string;
  message: string;
  rating: number;
  signature: string;
  timestamp: number;
  verified: boolean;
  indexedAt?: string;
  blockHeight?: number;
}

export interface ReputationData {
  verusId: string;
  name: string;
  score: number;
  rawAverage?: number;
  totalReviews: number;
  verifiedReviews?: number;
  uniqueReviewers?: number;
  reviewerDiversity?: number;
  confidence: number;
  trending?: number;
  recentReviews?: number;
  transparency?: number;
  sybilFlags?: string[];
  timestamps?: {
    oldest: string;
    newest: string;
    calculated: string;
  };
}

export interface TopAgent {
  verusId: string;
  name: string;
  totalReviews: number;
  verifiedReviews: number;
  averageRating: number;
  totalJobsCompleted: number;
}

// ------------------------------------------
// Data privacy types
// ------------------------------------------

export interface DataPolicy {
  agentVerusId: string;
  retention: 'none' | 'job-duration' | '30-days' | 'permanent';
  allowTraining: boolean;
  allowThirdParty: boolean;
  deletionAttestationSupported: boolean;
  modelInfo?: {
    provider?: string;
    model?: string;
    hosting?: 'self-hosted' | 'cloud' | 'undisclosed';
  };
  updatedAt: string;
}

export interface SetDataPolicyData {
  retention: 'none' | 'job-duration' | '30-days' | 'permanent';
  allowTraining: boolean;
  allowThirdParty: boolean;
  deletionAttestationSupported: boolean;
  modelInfo?: {
    provider?: string;
    model?: string;
    hosting?: 'self-hosted' | 'cloud' | 'undisclosed';
  };
}

export interface JobDataTerms {
  terms: {
    retention: string;
    allowTraining: boolean;
    allowThirdParty: boolean;
    requireDeletionAttestation: boolean;
    acceptedBySeller: boolean;
    acceptedAt: string;
  } | null;
  attestation: {
    signed: boolean;
    scope: string;
    signedAt: string;
    verified: boolean;
  } | null;
  jobStatus: string;
}

export interface DeletionAttestationRecord {
  id: string;
  jobId: string;
  agentVerusId: string;
  scope: string;
  signatureVerified: boolean;
  createdAt: string;
  note: string;
}

// ------------------------------------------
// Content moderation types
// ------------------------------------------

export interface HeldMessage {
  id: string;
  senderVerusId: string;
  content: string;
  safetyScore: number;
  holdReason: string;
  heldAt: string;
  appealCount: number;
  lastAppealAt: string | null;
}

export interface HoldQueueStats {
  totalHeld: number;
  byReason: Record<string, number>;
  averageHoldTime: number;
  appealRate: number;
}

// ------------------------------------------
// Safety types
// ------------------------------------------

export interface CanaryRecord {
  id: string;
  token: string;
  format: string;
  created_at: string;
}

// ------------------------------------------
// Alert types
// ------------------------------------------

export interface Alert {
  id: string;
  type: string;
  title: string;
  body: string;
  jobId?: string | null;
  read: boolean;
  createdAt: string;
}

export interface RawIdentityData {
  identity: {
    name: string;
    identityaddress: string;
    parent: string;
    contentmap?: Record<string, string>;
    contentmultimap?: Record<string, unknown[]>;
    primaryaddresses: string[];
    minimumsignatures: number;
    revocationauthority: string;
    recoveryauthority: string;
    systemid?: string;
    version?: number;
    flags?: number;
  };
  txid: string | null;
  blockHeight: number;
  prevOutput: {
    txid: string;
    vout: number;
    scriptHex: string;
    value: number;
  } | null;
}
