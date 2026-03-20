/**
 * J41Agent — Main agent class.
 * Combines identity, client, signing, and job handling into one interface.
 * 
 * @example
 * ```typescript
 * const agent = new J41Agent({
 *   apiUrl: 'https://api.autobb.app',
 *   wif: process.env.J41_AGENT_WIF!,
 * });
 * 
 * await agent.register('myagent');
 * await agent.start();
 * ```
 */

import { EventEmitter } from 'node:events';
import { J41Client } from './client/index.js';
import { generateKeypair, keypairFromWIF, type Keypair } from './identity/keypair.js';
import { signMessage } from './identity/signer.js';
import { buildDisputeRespondMessage, buildReworkAcceptMessage } from './signing/messages.js';
import { ChatClient, type IncomingMessage, type SessionEndingEvent, type SessionExpiringEvent, type JobStatusChangedEvent, type ReviewReceivedEvent } from './chat/client.js';
import type { JobHandler, JobHandlerConfig } from './jobs/types.js';
import type { Job, RegisterServiceData } from './client/index.js';
import type { SessionInput, AgentProfileInput } from './onboarding/finalize.js';
import { buildAgentContentMultimap, buildUpdateIdentityPayload } from './onboarding/vdxf.js';
import type { PrivacyTier } from './privacy/tiers.js';
import { generateAttestationPayload, signAttestation, type DeletionAttestation } from './privacy/attestation.js';
import { recommendPrice, type PriceRecommendation } from './pricing/calculator.js';
import type { JobCategory } from './pricing/tables.js';
import { generateCanary, checkForCanaryLeak, type CanaryConfig } from './safety/canary.js';
import { randomUUID } from 'node:crypto';
import { canonicalize } from 'json-canonicalize';
import { buildIdentityUpdateTx } from './identity/update.js';
import { VDXF_KEYS, PARENT_KEYS, DATA_DESCRIPTOR_KEY, makeSubDD } from './onboarding/vdxf.js';
import { WorkspaceClient } from './workspace/index.js';

/**
 * Thrown when identity registration is broadcast on-chain but block
 * confirmation times out. Carries partial context so callers can save
 * state and recover later.
 */
export class RegistrationTimeoutError extends Error {
  readonly onboardId: string;
  readonly lastStatus: string;
  readonly identityName: string;

  constructor(onboardId: string, lastStatus: string, identityName: string) {
    super(
      `Registration timed out waiting for block confirmation. ` +
      `The identity "${identityName}" may already exist on-chain. ` +
      `Use the recover command to check and resume.`
    );
    this.name = 'RegistrationTimeoutError';
    this.onboardId = onboardId;
    this.lastStatus = lastStatus;
    this.identityName = identityName;
  }
}

/** Default request timeout for raw fetch calls (ms) */
const FETCH_TIMEOUT = 30_000;

/** Minimum allowed polling interval (ms) */
const MIN_POLL_INTERVAL = 5_000;

export interface J41AgentConfig {
  /** J41 API base URL */
  apiUrl: string;
  /** WIF private key (omit to generate new keypair) */
  wif?: string;
  /** Identity name (e.g. myagent.agentplatform@) */
  identityName?: string;
  /** i-address */
  iAddress?: string;
  /** Job handler implementation */
  handler?: JobHandler;
  /** Job handler config */
  jobConfig?: JobHandlerConfig;
  network?: 'verus' | 'verustest';
}

export class J41Agent extends EventEmitter {
  private readonly _client: J41Client;
  private keypair: Keypair | null = null;
  private identityName: string | null;
  private iAddress: string | null;
  private wif: string | null;
  private handler: JobHandler | null;
  private jobConfig: JobHandlerConfig;
  private networkType: 'verus' | 'verustest' = 'verustest';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private chatClient: ChatClient | null = null;
  private _workspace: WorkspaceClient | null = null;
  private chatHandler: ((jobId: string, message: IncomingMessage) => void | Promise<void>) | null = null;
  private apiUrl: string;
  private canaryConfig: CanaryConfig | null = null;
  private polling = false;
  private seenJobIds = new Set<string>();
  private loginPromise: Promise<string> | null = null;

  constructor(config: J41AgentConfig) {
    super();

    if (config.apiUrl.startsWith('http://')) {
      console.warn('[J41] ⚠️  WARNING: Using insecure HTTP connection. Keys and signatures will be sent in cleartext. Use HTTPS in production.');
    }
    this.apiUrl = config.apiUrl;
    this._client = new J41Client({ apiUrl: config.apiUrl });
    // Wire auto re-auth: on 401/403, J41Client calls login() to refresh session (S2)
    this._client.setOnSessionExpired(async () => {
      console.log('[J41] Session expired, re-authenticating...');
      await this.login();
    });
    this.wif = config.wif || null;
    this.identityName = config.identityName || null;
    this.iAddress = config.iAddress || null;
    this.handler = config.handler || null;
    this.jobConfig = config.jobConfig || { pollInterval: 30_000 };
    this.networkType = config.network || 'verustest';

    // Prevent uncaught 'error' events from crashing the process.
    // Only log if no user-provided listener is registered.
    this.on('error', (err) => {
      if (this.listenerCount('error') <= 1) {
        console.error('[J41] Unhandled error:', err instanceof Error ? err.message : err);
      }
    });
  }

  /**
   * Read-only access to the underlying J41Client.
   * Use J41Agent methods for operations that require canary checking or authentication.
   */
  get client(): J41Client {
    return this._client;
  }

  /** Lazy workspace client — created on first access */
  get workspace(): WorkspaceClient {
    if (!this._workspace) {
      const token = this._client.getSessionToken();
      if (!token) throw new Error('Must be authenticated before accessing workspace');
      this._workspace = new WorkspaceClient({
        apiUrl: this._client.getBaseUrl(),
        sessionToken: token,
      });
    }
    return this._workspace;
  }

  /**
   * Generate a new keypair for this agent.
   * Call this before register() if no WIF was provided.
   */
  generateKeys(network?: 'verus' | 'verustest'): Keypair {
    const net = network || this.networkType;
    this.keypair = generateKeypair(net);
    this.wif = this.keypair.wif;
    return this.keypair;
  }

  /**
   * Authenticate with the J41 platform and return the session cookie.
   * Also sets the session token on the underlying J41Client for subsequent requests.
   * Shared by registerWithJ41(), registerService(), and enableCanaryProtection().
   */
  private async login(): Promise<string> {
    // Mutex: deduplicate concurrent login calls to prevent session token races
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = this._loginImpl();
    try {
      return await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  private async _loginImpl(): Promise<string> {
    if (!this.wif) throw new Error('WIF key required');
    if (!this.identityName) throw new Error('Identity name required');

    const challengeRes = await this._client.getAuthChallenge();
    if (challengeRes.expiresAt) {
      const expiryMs = new Date(challengeRes.expiresAt).getTime();
      if (Number.isNaN(expiryMs)) {
        throw new Error('Auth challenge has unparseable expiresAt timestamp');
      }
      if (expiryMs < Date.now()) {
        throw new Error('Auth challenge already expired — clock skew or stale response');
      }
    }

    const signature = signMessage(this.wif, challengeRes.challenge, this.networkType);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    let loginRes: Response;
    try {
      loginRes = await fetch(`${this.apiUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          challengeId: challengeRes.challengeId,
          verusId: this.identityName,
          signature,
        }),
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(`Login request timed out after ${FETCH_TIMEOUT}ms`);
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
      } catch { /* non-JSON response */ }
      throw new Error(`Login failed: ${errMsg}`);
    }

    const cookies = loginRes.headers.get('set-cookie');
    if (!cookies) {
      throw new Error('Login succeeded but no session cookie was returned');
    }

    // Extract session token and set on J41Client for subsequent API calls
    const match = cookies.match(/verus_session=([^;]+)/);
    if (!match) {
      throw new Error('Login succeeded but session cookie did not contain verus_session token');
    }
    this._client.setSessionToken(match[1]);

    // Return only the clean cookie name=value pair, not the full set-cookie with attributes
    return `verus_session=${match[1]}`;
  }

  /**
   * Authenticate with the J41 platform (public method).
   * Use this when resuming an agent that already has an on-chain identity
   * and just needs a session token to start polling/chatting.
   */
  async authenticate(): Promise<void> {
    await this.login();
    console.log('[J41] ✅ Authenticated');
    this.emit('authenticated');
  }

  /**
   * Register a new identity on the Junction41.
   * J41 creates a subID under agentplatform@ with your R-address.
   * 
   * @param name - Desired agent name (e.g. "myagent")
   * @returns Identity info once registered
   */
  async register(name: string, network: 'verus' | 'verustest' = 'verustest'): Promise<{ identity: string; iAddress: string }> {
    const previousNetwork = this.networkType;
    this.networkType = network;
    try {
    if (!this.keypair && this.wif) {
      this.keypair = keypairFromWIF(this.wif, network);
    } else if (!this.keypair) {
      this.generateKeys(network);
    }

    const kp = this.keypair!;

    console.log(`[J41] Registering "${name}.agentplatform@"...`);

    // Step 1: Request challenge
    console.log(`[J41] Requesting challenge...`);
    const challengeResp = await this._client.onboard(name, kp.address, kp.pubkey);

    if (challengeResp.status !== 'challenge') {
      throw new Error(`Unexpected response: ${JSON.stringify(challengeResp)}`);
    }

    // Step 2: Sign the challenge with our private key
    if (!challengeResp.challenge || !challengeResp.token) {
      throw new Error('Challenge response missing challenge or token');
    }
    const challenge = challengeResp.challenge;
    const token = challengeResp.token;
    // Onboarding: Use IdentitySignature format with R-address as identity
    // (the local verification expects this format, not legacy signMessage)
    // Onboarding challenge uses R-address message verification path on server.
    // Use legacy signMessage here; keep signChallenge for identity/i-address flows.
    const signature = signMessage(this.wif!, challenge, network);
    console.log(`[J41] Challenge signed. Submitting registration...`);

    // Step 3: Submit with signature
    const result = await this._client.onboardWithSignature(
      name, kp.address, kp.pubkey, challenge, token, signature
    );

    // Poll for completion (blocks can take 1-15 minutes depending on network)
    console.log(`[J41] Waiting for block confirmation (this can take several minutes)...`);
    let status = await this._client.onboardStatus(result.onboardId);
    let attempts = 0;
    const maxAttempts = 120; // ~20 minutes at 10s intervals

    while (status.status !== 'registered' && status.status !== 'failed' && attempts < maxAttempts) {
      await new Promise(r => setTimeout(r, 10_000));
      status = await this._client.onboardStatus(result.onboardId);
      attempts++;
      if (attempts % 6 === 0) {
        console.log(`[J41] Still waiting... (${Math.round(attempts * 10 / 60)}min elapsed, status: ${status.status})`);
      }
    }

    if (status.status === 'failed') {
      throw new Error(`Registration failed: ${status.error}`);
    }

    if (status.status !== 'registered') {
      throw new RegistrationTimeoutError(
        result.onboardId,
        status.status,
        `${name}.agentplatform@`,
      );
    }

    // Wait for real i-address (not 'pending-lookup')
    if (!status.iAddress || status.iAddress === 'pending-lookup') {
      console.log(`[J41] Waiting for i-address from J41...`);
      let iAddressAttempts = 0;
      const maxIAddressAttempts = 30; // 5 more minutes
      
      while ((!status.iAddress || status.iAddress === 'pending-lookup') && iAddressAttempts < maxIAddressAttempts) {
        await new Promise(r => setTimeout(r, 10_000));
        status = await this._client.onboardStatus(result.onboardId);
        iAddressAttempts++;
        if (iAddressAttempts % 6 === 0) {
          console.log(`[J41] Still waiting for i-address... (${Math.round(iAddressAttempts * 10 / 60)}min elapsed)`);
        }
      }
      
      if (!status.iAddress || status.iAddress === 'pending-lookup') {
        throw new Error('J41 did not return i-address — contact platform admin');
      }
    }

    if (!status.identity) {
      throw new Error('Server returned registered status without identity name');
    }
    if (!status.iAddress) {
      throw new Error('Server returned registered status without i-address');
    }
    this.identityName = status.identity;
    this.iAddress = status.iAddress;

    console.log(`[J41] ✅ Registered: ${this.identityName} (${this.iAddress})`);
    this.emit('registered', { identity: this.identityName, iAddress: this.iAddress });

    return { identity: this.identityName, iAddress: this.iAddress };
    } catch (err) {
      // Rollback networkType on failure to prevent corrupted state
      this.networkType = previousNetwork;
      throw err;
    }
  }

  /**
   * Register the agent with the J41 platform (after on-chain identity exists).
   * This creates the agent profile and enables receiving jobs.
   *
   * @param agentData - Agent profile data
   * @returns Registration result
   */
  async registerWithJ41(agentData: AgentProfileInput & {
    /** Set to false to disable automatic canary token registration (default: true) */
    canary?: boolean;
  }): Promise<{ agentId: string }> {
    if (!this.wif) {
      throw new Error('WIF key required for registration');
    }

    // Ensure keypair is derived when agent is instantiated from existing WIF
    if (!this.keypair) {
      this.keypair = keypairFromWIF(this.wif, this.networkType);
    }

    if (!this.identityName) {
      throw new Error('Identity name required (call register() first or set identityName)');
    }

    console.log(`[J41] Registering with J41 platform...`);

    // Step 1: Login (sets session token on J41Client for subsequent requests)
    console.log(`[J41] Logging in...`);
    await this.login();
    console.log(`[J41] ✅ Logged in`);

    // Step 2: Register agent with signed payload (S3: use J41Client.request() for retry+error handling)
    console.log(`[J41] Submitting registration...`);

    const payload = {
      verusId: this.identityName,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: randomUUID(),
      action: 'register' as const,
      data: agentData,
    };

    const message = canonicalize(payload);
    const regSignature = signMessage(this.wif, message, this.networkType);

    let isAlreadyRegistered = false;
    let agentIdResult = '';
    try {
      const result = await this._client.registerAgent({ ...payload, signature: regSignature });
      agentIdResult = result.agentId;
      console.log(`[J41] ✅ Registered with J41 platform`);
      this.emit('registeredWithJ41', { agentId: agentIdResult });
    } catch (regErr) {
      // 409 = already registered — continue (non-fatal)
      if (regErr instanceof Error && 'statusCode' in regErr && (regErr as { statusCode: number }).statusCode === 409) {
        isAlreadyRegistered = true;
        console.log(`[J41] Agent already registered`);
      } else {
        throw regErr;
      }
    }

    // Auto-register canary token (non-fatal on failure, runs even on 409 re-registration)
    if (agentData.canary !== false) {
      await this.registerCanaryToken();
    }

    // Build VDXF contentmultimap for on-chain publishing
    const profile: AgentProfileInput = {
      name: agentData.name,
      type: agentData.type,
      description: agentData.description,
      owner: agentData.owner,
      network: agentData.network,
      profile: agentData.profile,
      session: agentData.session,
      platformConfig: agentData.platformConfig,
      workspaceCapability: agentData.workspaceCapability,
    };

    const contentmultimap = buildAgentContentMultimap(profile);
    const identityName = this.identityName!;
    const updatePayload = buildUpdateIdentityPayload(identityName, contentmultimap);

    this.emit('vdxf:payload', { contentmultimap, updatePayload });

    return { agentId: isAlreadyRegistered ? 'existing' : agentIdResult };
  }

  /**
   * Register a canary token with SovGuard (non-fatal on failure).
   * Uses J41Client.registerCanary() for retry + error handling (S3).
   */
  private async registerCanaryToken(): Promise<void> {
    try {
      const canary = generateCanary();
      await this._client.registerCanary(canary.registration);
      this.canaryConfig = canary;
      this.emit('canary:registered', { active: true });
      console.log('[J41] Canary token registered with SovGuard');
    } catch (e) {
      console.warn('[J41] Canary registration failed (non-fatal):', (e as Error).message);
    }
  }

  /**
   * Register a service offering.
   * Must be called after registerWithJ41().
   */
  async registerService(serviceData: {
    name: string;
    description?: string;
    category?: string;
    price?: number;
    currency?: string;
    turnaround?: string;
    paymentTerms?: 'prepay' | 'postpay' | 'split';
    privateMode?: boolean;
    sovguard?: boolean;
    acceptedCurrencies?: Array<{ currency: string; price: number }>;
    resolutionWindow?: number;
    refundPolicy?: { policy: 'fixed' | 'negotiable' | 'none'; percent?: number };
  }): Promise<{ serviceId: string }> {
    if (!this.identityName) {
      throw new Error('Identity name required');
    }

    console.log(`[J41] Registering service: ${serviceData.name}...`);
    await this.login();

    // S3: Map convenience fields (currency → priceCurrency) to API-expected shape.
    // Price may arrive as a string from CLI tools — coerce to number.
    const apiData: RegisterServiceData = {
      name: serviceData.name,
      description: serviceData.description,
      category: serviceData.category,
      price: typeof serviceData.price === 'string'
        ? parseFloat(serviceData.price as unknown as string)
        : serviceData.price,
      priceCurrency: serviceData.currency || 'VRSC',
      turnaround: serviceData.turnaround,
      paymentTerms: serviceData.paymentTerms,
      privateMode: serviceData.privateMode,
      sovguard: serviceData.sovguard,
      acceptedCurrencies: serviceData.acceptedCurrencies,
      resolutionWindow: serviceData.resolutionWindow,
      refundPolicy: serviceData.refundPolicy,
    };
    const result = await this._client.registerService(apiData);
    console.log(`[J41] ✅ Service registered: ${serviceData.name}`);
    return result;
  }

  // ------------------------------------------
  // File sharing
  // ------------------------------------------

  /**
   * Upload a file to a job.
   * @param jobId - Job ID
   * @param filePath - Local file path to upload
   * @returns Uploaded file metadata
   */
  async uploadFile(jobId: string, filePath: string): Promise<import('./client/index.js').JobFile> {
    const fs = await import('fs');
    const path = await import('path');
    const data = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    return this._client.uploadFile(jobId, new Blob([data]), filename);
  }

  /**
   * Upload raw data as a file to a job.
   * @param jobId - Job ID
   * @param data - File content as string or Buffer
   * @param filename - Filename to use
   * @param mimeType - Optional MIME type
   * @returns Uploaded file metadata
   */
  async uploadFileData(jobId: string, data: string | Buffer | Uint8Array, filename: string, mimeType?: string): Promise<import('./client/index.js').JobFile> {
    const buf = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
    const blob = new Blob([buf], mimeType ? { type: mimeType } : undefined);
    return this._client.uploadFile(jobId, blob, filename, mimeType);
  }

  /**
   * Download a file from a job.
   * @param jobId - Job ID
   * @param fileId - File ID
   * @returns File data, filename, mimeType, and checksum
   */
  async downloadFile(jobId: string, fileId: string): Promise<{ data: ArrayBuffer; filename: string; mimeType: string; checksum: string }> {
    return this._client.downloadFile(jobId, fileId);
  }

  /**
   * Download a file and save it to a local path.
   * @param jobId - Job ID
   * @param fileId - File ID
   * @param outputDir - Directory to save to (defaults to cwd)
   * @returns Local file path
   */
  async downloadFileTo(jobId: string, fileId: string, outputDir?: string): Promise<string> {
    const fs = await import('fs');
    const path = await import('path');
    const result = await this._client.downloadFile(jobId, fileId);
    const dir = outputDir || process.cwd();
    const filePath = path.join(dir, result.filename);
    fs.writeFileSync(filePath, Buffer.from(result.data));
    return filePath;
  }

  /**
   * List files attached to a job.
   */
  async listFiles(jobId: string): Promise<{ data: import('./client/index.js').JobFile[]; meta: { count: number; maxFiles: number; totalStorageBytes: number; maxStorageBytes: number } }> {
    return this._client.getJobFiles(jobId);
  }

  /**
   * Delete a file from a job (uploader only).
   */
  async deleteFile(jobId: string, fileId: string): Promise<{ deleted: boolean }> {
    return this._client.deleteFile(jobId, fileId);
  }

  /**
   * Push a VDXF status update on-chain (active/inactive).
   * Builds and broadcasts a signed identity update tx.
   */
  private async _updateOnChainStatus(status: 'active' | 'inactive'): Promise<string | null> {
    if (!this.wif || !this.iAddress) return null;

    try {
      await this.login();

      const vdxfAdditions: Record<string, unknown[]> = {};
      const agentSubDDs = [makeSubDD(VDXF_KEYS.agent.status, status)];
      vdxfAdditions[PARENT_KEYS.agent] = [{
        [DATA_DESCRIPTOR_KEY]: {
          version: 1,
          flags: 32,
          objectdata: agentSubDDs,
          label: PARENT_KEYS.agent,
        },
      }];

      const { data: identityData } = await this._client.getIdentityRaw();
      const utxoResp = await this._client.getUtxos();
      const utxos = utxoResp.utxos || utxoResp;

      if (!utxos.length) {
        console.warn(`[J41]   ⚠️  No UTXOs — cannot update on-chain status`);
        return null;
      }

      const rawhex = buildIdentityUpdateTx({
        wif: this.wif,
        identityData,
        utxos,
        vdxfAdditions,
        network: this.networkType,
      });

      const txResult = await this._client.broadcast(rawhex);
      const txid = txResult.txid || txResult;
      console.log(`[J41]   On-chain status → ${status} (txid: ${txid})`);
      return txid as string;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[J41]   ⚠️  On-chain status update failed: ${msg}`);
      return null;
    }
  }

  /**
   * Deactivate the agent: update on-chain status, toggle platform status,
   * and optionally remove service listings.
   *
   * @param options.removeServices - Also delete all service listings (default: true)
   * @param options.onChain - Also update VDXF status to inactive on-chain (default: true)
   * @returns Deactivation result with status
   */
  async deactivate(options: { removeServices?: boolean; onChain?: boolean } = {}): Promise<{
    status: string;
    servicesRemoved: number;
    onChainTxid: string | null;
  }> {
    const removeServices = options.removeServices ?? true;
    const onChain = options.onChain ?? true;

    if (!this.identityName || !this.iAddress) {
      throw new Error('Identity name and iAddress required for deactivation');
    }

    console.log(`[J41] Deactivating agent ${this.identityName}...`);
    await this.login();

    let servicesRemoved = 0;
    let onChainTxid: string | null = null;

    // 1. Update on-chain VDXF status
    if (onChain) {
      onChainTxid = await this._updateOnChainStatus('inactive');
    }

    // 2. Remove services
    if (removeServices) {
      try {
        const svcResp = await this._client.getMyServices();
        const services = svcResp.data || [];
        for (const svc of services) {
          try {
            await this._client.deleteService(svc.id);
            console.log(`[J41]   Removed service: ${svc.name}`);
            servicesRemoved++;
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(`[J41]   ⚠️  Failed to remove service ${svc.name}: ${msg}`);
          }
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[J41]   ⚠️  Could not list services: ${msg}`);
      }
    }

    // 3. Toggle platform status
    const verusId = this.iAddress || this.identityName!;
    const timestamp = Date.now();
    const nonce = randomUUID();
    const message = `status:inactive:${timestamp}`;
    const signature = signMessage(this.wif!, message, this.networkType);

    const result = await this._client.setAgentStatus(
      verusId,
      'inactive',
      signature,
      timestamp,
      nonce,
    );

    console.log(`[J41] ✅ Agent deactivated: ${result.status}`);
    return { status: result.status, servicesRemoved, onChainTxid };
  }

  /**
   * Reactivate a previously deactivated agent on the platform
   * and update on-chain VDXF status to active.
   *
   * @param options.onChain - Also update VDXF status to active on-chain (default: true)
   */
  async activate(options: { onChain?: boolean } = {}): Promise<{
    status: string;
    onChainTxid: string | null;
  }> {
    const onChain = options.onChain ?? true;

    if (!this.identityName) {
      throw new Error('Identity name required for activation');
    }

    console.log(`[J41] Activating agent ${this.identityName}...`);
    await this.login();

    let onChainTxid: string | null = null;

    // 1. Update on-chain VDXF status
    if (onChain) {
      onChainTxid = await this._updateOnChainStatus('active');
    }

    // 2. Toggle platform status
    const verusId = this.iAddress || this.identityName;
    const timestamp = Date.now();
    const nonce = randomUUID();
    const message = `status:active:${timestamp}`;
    const signature = signMessage(this.wif!, message, this.networkType);

    const result = await this._client.setAgentStatus(
      verusId,
      'active',
      signature,
      timestamp,
      nonce,
    );

    console.log(`[J41] ✅ Agent activated: ${result.status}`);
    return { status: result.status, onChainTxid };
  }

  /**
   * Set the job handler (how your agent responds to jobs).
   */
  setHandler(handler: JobHandler): void {
    this.handler = handler;
  }

  /**
   * Start listening for jobs.
   * Uses polling by default — webhook and websocket support coming.
   */
  async start(): Promise<void> {
    if (this.running) return;

    if (!this._client.getSessionToken()) {
      throw new Error('Agent must be authenticated before starting. Call registerWithJ41() or login first.');
    }

    // Prevent double-start race: set running before any async work
    this.running = true;

    const interval = Math.max(this.jobConfig.pollInterval || 30_000, MIN_POLL_INTERVAL);
    console.log(`[J41] Listening for jobs (polling every ${interval / 1000}s)...`);

    // Initial check (non-fatal — still start polling even if first check fails)
    try {
      await this.checkForJobs();
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }

    this.pollTimer = setInterval(() => {
      if (!this.running) return;
      this.checkForJobs().catch((err) => {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      });
    }, interval);

    // Guard against stop() being called during the initial checkForJobs() await
    if (!this.running) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      return;
    }

    this.emit('started');
  }

  /**
   * Stop listening for jobs.
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.running = false;
    // Don't clear seenJobIds — persist across stop/start to avoid re-processing jobs
    this.emit('stopped');
    console.log('[J41] Stopped.');
    this.chatClient?.disconnect();
    this.chatClient = null;
    this._workspace?.disconnect();
    this._workspace = null;
  }

  /**
   * Connect to SovGuard WebSocket for real-time messaging.
   * Call after login (needs session token on client).
   */
  async connectChat(): Promise<void> {
    if (!this._client.getSessionToken()) {
      throw new Error('Must be logged in before connecting to chat');
    }

    // Clean up existing chat client to prevent socket leaks
    if (this.chatClient) {
      this.chatClient.disconnect();
      this.chatClient = null;
    }

    this.chatClient = new ChatClient({
      apiUrl: this._client.getBaseUrl(),
      sessionToken: this._client.getSessionToken()!,
    });

    // S4: Surface chat reconnect failures so callers can handle silent death
    this.chatClient.onReconnectFailed = (err) => {
      this.emit('chat:reconnectFailed', err);
      this.emit('error', new Error(`Chat permanently disconnected: ${err.message}`));
    };

    this.chatClient.onMessage((msg) => {
      // Don't handle our own messages — check both iAddress and identityName independently
      if (msg.senderVerusId === this.iAddress || msg.senderVerusId === this.identityName) return;

      this.emit('chat:message', msg);
      if (this.chatHandler) {
        const result = this.chatHandler(msg.jobId, msg);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch((e) => {
            this.emit('error', e instanceof Error ? e : new Error(String(e)));
          });
        }
      }
    });

    // Wire up session/job lifecycle events
    this.chatClient.onSessionEnding(async (event: SessionEndingEvent) => {
      this.emit('session:ending', event);
      if (this.handler?.onSessionEnding) {
        try {
          const job = await this._client.getJob(event.jobId);
          await this.handler.onSessionEnding(job, event.reason, event.requestedBy);
        } catch (err) {
          this.emit('error', err instanceof Error ? err : new Error(String(err)));
        }
      } else {
        // Default: auto-deliver when no custom handler is provided
        console.log(`[J41] Session ending for job ${event.jobId} — auto-delivering...`);
        try {
          await this.autoDeliver(event.jobId);
        } catch (err) {
          this.emit('error', err instanceof Error ? err : new Error(String(err)));
        }
      }
    });

    this.chatClient.onSessionExpiring((event: SessionExpiringEvent) => {
      this.emit('session:expiring', event);
    });

    this.chatClient.onJobStatusChanged(async (event: JobStatusChangedEvent) => {
      this.emit('job:statusChanged', event);
      // Dispatch to relevant JobHandler hooks based on new status
      if (!this.handler) return;
      try {
        const job = await this._client.getJob(event.jobId);
        if (event.status === 'in_progress' && this.handler.onJobStarted) {
          await this.handler.onJobStarted(job);
        } else if (event.status === 'completed' && this.handler.onJobCompleted) {
          await this.handler.onJobCompleted(job);
        } else if (event.status === 'disputed' && this.handler.onJobDisputed) {
          await this.handler.onJobDisputed(job, 'Dispute raised');
        } else if (event.status === 'cancelled' && this.handler.onJobCancelled) {
          await this.handler.onJobCancelled(job, event.reason);
        }
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    });

    // Handle review notifications — auto-accept and update identity on-chain
    this.chatClient.onReviewReceived(async (event: ReviewReceivedEvent) => {
      this.emit('review:received', event);
      console.log(`[J41] Review received for job ${event.jobHash} (rating: ${event.rating}) — processing...`);
      try {
        await this.acceptReview(event.inboxId);
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    });

    await this.chatClient.connect();
    console.log('[CHAT] ✅ Connected to SovGuard');

    // Join rooms for any active jobs we're the seller on
    try {
      const accepted = await this._client.getMyJobs({ status: 'accepted', role: 'seller' });
      const inProgress = await this._client.getMyJobs({ status: 'in_progress', role: 'seller' });
      const allJobs = [...(accepted.data || []), ...(inProgress.data || [])];
      for (const job of allJobs) {
        this.chatClient.joinJob(job.id);
      }
      if (allJobs.length > 0) {
        console.log(`[CHAT] Joined ${allJobs.length} active job room(s)`);
      }
    } catch (e) {
      console.error('[CHAT] Failed to join existing job rooms:', e);
    }
  }

  /**
   * Set a handler for incoming chat messages.
   * Handler receives (jobId, message) and can call sendChatMessage() to reply.
   */
  onChatMessage(handler: (jobId: string, message: IncomingMessage) => void | Promise<void>): void {
    this.chatHandler = handler;
  }

  /**
   * Send a chat message in a job room.
   */
  sendChatMessage(jobId: string, content: string): void {
    if (!this.chatClient?.isConnected) {
      throw new Error('Chat not connected');
    }
    if (this.canaryConfig && checkForCanaryLeak(content, this.canaryConfig.token)) {
      throw new Error(
        'Canary token detected in outbound message — potential prompt injection leak. Message blocked.'
      );
    }
    this.chatClient.sendMessage(jobId, content);
  }

  /**
   * Auto-deliver a job (used as default when session ends and no custom handler is set).
   * Signs a delivery message and submits it to the platform.
   */
  private async autoDeliver(jobId: string): Promise<void> {
    if (!this.wif || !this.iAddress) {
      console.error(`[J41] Cannot auto-deliver job ${jobId}: WIF key and i-address required`);
      return;
    }

    try {
      const job = await this._client.getJob(jobId);

      // Only deliver if job is in a deliverable state
      if (job.status !== 'accepted' && job.status !== 'in_progress') {
        console.log(`[J41] Job ${jobId} is in status '${job.status}', skipping auto-deliver`);
        return;
      }

      const timestamp = Math.floor(Date.now() / 1000);
      const deliveryHash = 'session-ended';
      const deliveryMessage = 'Session ended — work delivered automatically.';
      const message = `J41-DELIVER|Job:${job.jobHash}|Delivery:${deliveryHash}|Ts:${timestamp}|I have delivered the work for this job.`;
      const signature = signMessage(this.wif, message, this.networkType);

      await this._client.deliverJob(jobId, deliveryHash, signature, timestamp, deliveryMessage);
      console.log(`[J41] ✅ Auto-delivered job ${jobId}`);
      this.emit('job:delivered', { jobId });
    } catch (err) {
      console.error(`[J41] Auto-deliver failed for job ${jobId}:`, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /**
   * Set revocation and recovery authorities for this agent's identity.
   * Builds and broadcasts a signed updateidentity transaction.
   *
   * IMPORTANT: Once set, only the revocation authority can revoke this identity,
   * and only the recovery authority can recover it. Choose trusted i-addresses.
   *
   * @param revokeAddress - i-address of the revocation authority
   * @param recoverAddress - i-address of the recovery authority
   * @returns Transaction ID of the broadcast update
   */
  async setRevokeRecoverAuthorities(revokeAddress: string, recoverAddress: string): Promise<string> {
    if (!this.wif || !this.iAddress) {
      throw new Error('WIF key and iAddress are required to update identity authorities');
    }

    // Validate i-address format
    if (!revokeAddress.startsWith('i') || revokeAddress.length < 30) {
      throw new Error(`Invalid revocation authority address: ${revokeAddress}`);
    }
    if (!recoverAddress.startsWith('i') || recoverAddress.length < 30) {
      throw new Error(`Invalid recovery authority address: ${recoverAddress}`);
    }

    console.log(`[J41] Setting revocation authority: ${revokeAddress}`);
    console.log(`[J41] Setting recovery authority: ${recoverAddress}`);

    // Fetch current identity data + UTXOs
    const [{ data: identityData }, utxoData] = await Promise.all([
      this._client.getIdentityRaw(),
      this._client.getUtxos(),
    ]);

    if (!identityData.prevOutput) {
      throw new Error('Identity previous output not found — identity may not be confirmed on-chain');
    }

    // Check if authorities are already set correctly
    if (identityData.identity.revocationauthority === revokeAddress &&
        identityData.identity.recoveryauthority === recoverAddress) {
      console.log(`[J41] Authorities already set correctly, no update needed`);
      return 'already-set';
    }

    // Build identity update transaction with new authorities (no VDXF changes)
    const signedTxHex = buildIdentityUpdateTx({
      wif: this.wif,
      identityData,
      utxos: utxoData.utxos,
      vdxfAdditions: {}, // no content changes
      network: this.networkType,
      revocationauthority: revokeAddress,
      recoveryauthority: recoverAddress,
    });

    // Broadcast
    const result = await this._client.broadcast(signedTxHex);
    console.log(`[J41] ✅ Authorities updated on-chain: ${result.txid}`);

    return result.txid;
  }

  /**
   * Check the current revocation and recovery authorities for this identity.
   * Warns if they are self-referential (identity is its own authority = weaker security).
   *
   * @returns Object with authority addresses and warning flags
   */
  async checkAuthorities(): Promise<{
    revocationauthority: string;
    recoveryauthority: string;
    identityaddress: string;
    selfRevoke: boolean;
    selfRecover: boolean;
  }> {
    const { data: identityData } = await this._client.getIdentityRaw();
    const id = identityData.identity;
    const selfRevoke = id.revocationauthority === id.identityaddress;
    const selfRecover = id.recoveryauthority === id.identityaddress;

    if (selfRevoke) {
      console.warn(`[J41] ⚠️  Revocation authority is self-referential — if WIF is compromised, attacker can revoke your identity`);
    }
    if (selfRecover) {
      console.warn(`[J41] ⚠️  Recovery authority is self-referential — if WIF is compromised, attacker controls recovery`);
    }

    return {
      revocationauthority: id.revocationauthority,
      recoveryauthority: id.recoveryauthority,
      identityaddress: id.identityaddress,
      selfRevoke,
      selfRecover,
    };
  }

  /**
   * Accept a review from the inbox and update identity on-chain.
   * Builds a signed updateidentity transaction, broadcasts it, and marks the inbox item as accepted.
   */
  async acceptReview(inboxId: string): Promise<void> {
    if (!this.wif || !this.iAddress) {
      console.error(`[J41] Cannot accept review ${inboxId}: WIF key and i-address required`);
      return;
    }

    try {
      // 1. Fetch the inbox item to get VDXF data
      const { data: inboxItem } = await this._client.getInboxItem(inboxId);
      if (inboxItem.status !== 'pending') {
        console.log(`[J41] Inbox item ${inboxId} already ${inboxItem.status}, skipping`);
        return;
      }

      // 2. Get current identity data + UTXOs from platform
      const [{ data: identityData }, utxoData] = await Promise.all([
        this._client.getIdentityRaw(),
        this._client.getUtxos(),
      ]);

      if (!identityData.prevOutput) {
        console.error(`[J41] Cannot accept review: identity previous output not found`);
        return;
      }

      if (!utxoData.utxos || utxoData.utxos.length === 0) {
        console.error(`[J41] Cannot accept review: no UTXOs available for fee`);
        return;
      }

      // 3. Build nested DD VDXF additions from the inbox item's review data
      const reviewKeys = VDXF_KEYS.review;
      const vdxfAdditions: Record<string, unknown[]> = {};

      // Check if vdxfData is already in nested DD format (has parent key)
      const hasNestedDD = inboxItem.vdxfData &&
        Object.keys(inboxItem.vdxfData).some((k: string) => k === PARENT_KEYS.review);
      if (hasNestedDD) {
        // Use pre-computed nested DD data from the inbox item
        for (const [key, value] of Object.entries(inboxItem.vdxfData!)) {
          if (value != null) {
            vdxfAdditions[key] = Array.isArray(value) ? value : [value];
          }
        }
      } else {
        // Build consolidated review.record JSON blob
        const reviewRecord: Record<string, unknown> = {
          timestamp: Math.floor(Date.now() / 1000),
        };
        if (inboxItem.senderVerusId) reviewRecord.buyer = inboxItem.senderVerusId;
        if (inboxItem.jobHash) reviewRecord.jobHash = inboxItem.jobHash;
        if (inboxItem.signature) reviewRecord.signature = inboxItem.signature;
        if (inboxItem.message) reviewRecord.message = inboxItem.message;
        if (inboxItem.rating != null) reviewRecord.rating = inboxItem.rating;

        const subDDs: object[] = [makeSubDD(reviewKeys.record, JSON.stringify(reviewRecord))];

        vdxfAdditions[PARENT_KEYS.review] = [{
          [DATA_DESCRIPTOR_KEY]: {
            version: 1,
            flags: 32,
            objectdata: subDDs,
            label: PARENT_KEYS.review,
          },
        }];
      }

      // 4. Build and sign the identity update transaction
      console.log(`[J41] Building identity update transaction...`);
      const signedTxHex = buildIdentityUpdateTx({
        wif: this.wif,
        identityData,
        utxos: utxoData.utxos,
        vdxfAdditions,
        network: this.networkType,
      });

      // 5. Broadcast the signed transaction
      console.log(`[J41] Broadcasting identity update transaction...`);
      const broadcastResult = await this._client.broadcast(signedTxHex);
      console.log(`[J41] ✅ Identity updated on-chain: ${broadcastResult.txid}`);

      // 6. Mark inbox item as accepted
      await this._client.acceptInboxItem(inboxId, broadcastResult.txid);
      console.log(`[J41] ✅ Review accepted and identity updated`);

      this.emit('review:accepted', {
        inboxId,
        txid: broadcastResult.txid,
      });
    } catch (err) {
      console.error(`[J41] Failed to accept review ${inboxId}:`, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /**
   * Respond to a dispute (seller side). Auto-signs the response.
   */
  async respondToDispute(jobId: string, options: {
    action: 'refund' | 'rework' | 'rejected';
    refundPercent?: number;
    reworkCost?: number;
    message: string;
  }): Promise<{ status: string; dispute: object }> {
    if (!this.wif) throw new Error('Agent not initialized with WIF');
    if (!this.iAddress) throw new Error('Agent not initialized with i-address');

    const job = await this._client.getJob(jobId);
    const jobHash = job.signatures?.request || job.jobHash || job.id;
    const timestamp = Math.floor(Date.now() / 1000);

    const msg = buildDisputeRespondMessage({ jobHash, action: options.action, timestamp });
    const signature = signMessage(this.wif, msg, this.networkType);

    const result = await this._client.respondToDispute(jobId, {
      ...options,
      timestamp,
      signature,
    });

    this.emit('dispute:responded', { jobId, action: options.action });
    return result;
  }

  /**
   * Accept a rework offer (buyer side). Auto-signs the acceptance.
   */
  async acceptRework(jobId: string): Promise<{ status: string }> {
    if (!this.wif) throw new Error('Agent not initialized with WIF');

    const job = await this._client.getJob(jobId);
    const jobHash = job.signatures?.request || job.jobHash || job.id;
    const timestamp = Math.floor(Date.now() / 1000);

    const msg = buildReworkAcceptMessage({ jobHash, timestamp });
    const signature = signMessage(this.wif, msg, this.networkType);

    const result = await this._client.acceptRework(jobId, { timestamp, signature });

    this.emit('rework:accepted', { jobId });
    return result;
  }

  /**
   * Join a specific job's chat room.
   */
  joinJobChat(jobId: string): void {
    this.chatClient?.joinJob(jobId);
  }

  /**
   * Check for new job requests and process them.
   */
  /** Maximum number of job IDs to track for deduplication */
  private static readonly MAX_SEEN_JOBS = 10_000;

  private async checkForJobs(): Promise<void> {
    if (!this.handler || this.polling) return;
    this.polling = true;

    try {
      const res = await this._client.getMyJobs({ status: 'requested', role: 'seller' });
      const jobs = res.data || [];

      for (const job of jobs) {
        // Stop processing if agent was stopped mid-poll
        if (!this.running) break;

        // Skip jobs without an id (malformed response) or already processed
        if (!job.id) continue;
        if (this.seenJobIds.has(job.id)) continue;

        try {
          this.emit('job:requested', job);

          if (this.handler.onJobRequested) {
            const decision = await this.handler.onJobRequested(job);

            if (decision === 'accept') {
              if (!this.wif || !this.iAddress) {
                this.emit('error', new Error(`Cannot accept job ${job.id}: WIF key and i-address required`));
                continue;
              }
              try {
                const timestamp = Math.floor(Date.now() / 1000);
                const acceptMessage = `J41-ACCEPT|Job:${job.jobHash}|Buyer:${job.buyerVerusId}|Amt:${job.amount} ${job.currency}|Ts:${timestamp}|I accept this job and commit to delivering the work.`;
                const signature = signMessage(this.wif, acceptMessage, this.networkType);
                await this._client.acceptJob(job.id, signature, timestamp);
                this.seenJobIds.add(job.id);
                this.emit('job:accepted', job);
                // Auto-join chat room if chat is connected
                if (this.chatClient?.isConnected) {
                  this.chatClient.joinJob(job.id);
                }
              } catch (err) {
                // Don't mark as seen on failure — allow retry on next poll
                this.emit('error', new Error(`Failed to accept job ${job.id}: ${err instanceof Error ? err.message : String(err)}`));
              }
            } else if (decision === 'reject') {
              this.seenJobIds.add(job.id);
              this.emit('job:rejected', job);
            }
            // 'hold' = do nothing; NOT added to seenJobIds so it's re-evaluated next poll
          } else {
            // No onJobRequested handler — mark as seen to avoid repeated job:requested events
            this.seenJobIds.add(job.id);
          }
        } catch (jobErr) {
          // Per-job error: don't skip remaining jobs in batch
          this.emit('error', jobErr instanceof Error ? jobErr : new Error(String(jobErr)));
        }
      }

      // Evict oldest entries if the set grows too large
      while (this.seenJobIds.size > J41Agent.MAX_SEEN_JOBS) {
        const first = this.seenJobIds.values().next().value;
        if (first !== undefined) this.seenJobIds.delete(first);
        else break;
      }
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.polling = false;
    }
  }

  /** Get the agent's identity name */
  get identity(): string | null {
    return this.identityName;
  }

  /** Get the agent's i-address */
  get address(): string | null {
    return this.iAddress;
  }

  /** Check if agent is currently listening for jobs */
  get isRunning(): boolean {
    return this.running;
  }

  // ------------------------------------------
  // Canary Protection
  // ------------------------------------------

  /**
   * Enable canary protection standalone (after initial registration, or to re-enable with a new token).
   * Generates a new canary token and registers it with SovGuard.
   * Returns the systemPromptInsert for embedding; the raw token is kept internal.
   */
  async enableCanaryProtection(): Promise<{ active: boolean; systemPromptInsert: string }> {
    await this.login();
    const canary = generateCanary();

    // S3: Use J41Client.registerCanary() for retry + error handling
    await this._client.registerCanary(canary.registration);

    this.canaryConfig = canary;
    this.emit('canary:registered', { active: true });
    return { active: true, systemPromptInsert: canary.systemPromptInsert };
  }

  /**
   * Wrap a system prompt with the agent's canary token.
   * The canary must be initialized first (via registerWithJ41() or enableCanaryProtection()).
   */
  getProtectedSystemPrompt(systemPrompt: string): string {
    if (!this.canaryConfig) {
      throw new Error('Canary not initialized — call registerWithJ41() or enableCanaryProtection() first');
    }
    return systemPrompt + '\n' + this.canaryConfig.systemPromptInsert;
  }

  /** Whether canary protection is currently active */
  get canaryActive(): boolean {
    return this.canaryConfig !== null;
  }

  // ------------------------------------------
  // Privacy Tier
  // ------------------------------------------

  private privacyTier: PrivacyTier = 'standard';

  /**
   * Set the agent's privacy tier.
   * Stores locally and updates the platform profile.
   */
  async setPrivacyTier(tier: PrivacyTier): Promise<void> {
    this.privacyTier = tier;
    await this._client.updateAgentProfile({ privacyTier: tier });
    this.emit('privacy:updated', tier);
  }

  /** Get the current privacy tier */
  getPrivacyTier(): PrivacyTier {
    return this.privacyTier;
  }

  // ------------------------------------------
  // Deletion Attestation
  // ------------------------------------------

  /**
   * Generate, sign, and submit a deletion attestation.
   * Call this after destroying a job's container and data.
   * 
   * @param jobId - The job ID
   * @param containerId - Docker/OCI container ID that was destroyed
   * @param dataVolumes - List of volume paths that were deleted
   * @param deletionMethod - Method used (default: 'container-destroy+volume-rm')
   * @returns The signed attestation
   */
  async attestDeletion(
    jobId: string,
    containerId: string,
    options?: {
      createdAt?: string;
      destroyedAt?: string;
      dataVolumes?: string[];
      deletionMethod?: string;
    },
    network?: 'verus' | 'verustest',
  ): Promise<DeletionAttestation> {
    const net = network ?? this.networkType;
    if (!this.wif) {
      throw new Error('WIF key required for signing attestations');
    }
    if (!this.identityName) {
      throw new Error('Agent must be registered before attesting deletions');
    }

    const now = new Date().toISOString();
    const payload = generateAttestationPayload({
      jobId,
      containerId,
      createdAt: options?.createdAt || now,
      destroyedAt: options?.destroyedAt || now,
      dataVolumes: options?.dataVolumes,
      deletionMethod: options?.deletionMethod,
      attestedBy: this.identityName,
    });

    const attestation = signAttestation(payload, this.wif, net);

    // Submit to platform
    await this._client.submitAttestation(attestation);
    this.emit('attestation:submitted', attestation);

    return attestation;
  }

  // ------------------------------------------
  // Pricing
  // ------------------------------------------

  /**
   * Estimate pricing for a job based on model, category, and token usage.
   * Pure local calculation — no API call needed.
   * 
   * @param model - LLM model name
   * @param category - Job category (trivial, simple, medium, complex, premium)
   * @param inputTokens - Estimated input tokens (default: 2000)
   * @param outputTokens - Estimated output tokens (default: 1000)
   * @returns Price recommendation with min/recommended/premium/ceiling
   */
  estimatePrice(
    model: string,
    category: JobCategory,
    inputTokens: number = 2000,
    outputTokens: number = 1000,
  ): PriceRecommendation {
    return recommendPrice({
      model,
      inputTokens,
      outputTokens,
      category,
      privacyTier: this.privacyTier,
    });
  }
}
