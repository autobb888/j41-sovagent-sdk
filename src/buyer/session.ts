/**
 * BuyerSession — manages the buyer side of an agent-to-agent job.
 *
 * Handles: job creation, payment, chat, and session lifecycle.
 * The buyer agent can send messages, receive responses, and
 * optionally provide workspace access.
 */

import type { J41Agent } from '../agent.js';
import type { Job } from '../client/index.js';
import { BuyerWorkspace, type BuyerWorkspaceConfig } from './workspace.js';

export interface BuyerSessionConfig {
  /** The buyer agent instance (authenticated) */
  agent: J41Agent;
  /** Seller's i-address or VerusID */
  sellerVerusId: string;
  /** Job description */
  description: string;
  /** Payment amount */
  amount: number;
  /** Payment currency */
  currency?: string;
  /** Service ID (optional — for marketplace service listings) */
  serviceId?: string;
  /** Callback when seller sends a message */
  onMessage?: (message: string, meta: { senderVerusId: string; jobId: string }) => void | Promise<void>;
  /** Callback when session ends */
  onSessionEnd?: (reason: string) => void;
  /** Auto-end session after this many seconds of idle (0 = never) */
  autoEndIdleSec?: number;
}

export class BuyerSession {
  private agent: J41Agent;
  private config: BuyerSessionConfig;
  private job: Job | null = null;
  private _active = false;
  private _lastActivity = Date.now();
  private _idleTimer: ReturnType<typeof setInterval> | null = null;
  private _messageHandler: ((jobId: string, msg: any) => void) | null = null;
  private _workspace: BuyerWorkspace | null = null;

  constructor(config: BuyerSessionConfig) {
    this.agent = config.agent;
    this.config = config;
  }

  /** Create the job and pay for it. Returns the job object. */
  async start(): Promise<Job> {
    // Create job
    this.job = await this.agent.createJob({
      sellerVerusId: this.config.sellerVerusId,
      description: this.config.description,
      amount: this.config.amount,
      currency: this.config.currency || 'VRSCTEST',
      serviceId: this.config.serviceId,
    });

    console.log(`[BuyerSession] Job created: ${this.job.id}`);

    // Pay — dual output TX (agent + platform fee in one transaction)
    const payAddr = this.job.payment?.address;
    if (!payAddr) {
      throw new Error('No payment address on job — backend may not have resolved seller R-address');
    }

    const feeAddr = this.job.payment?.platformFeeAddress;
    const feeAmt = this.job.payment?.feeAmount;

    const outputs: Array<{ address: string; amount: number }> = [
      { address: payAddr, amount: this.config.amount },
    ];
    if (feeAddr && feeAmt && feeAmt > 0) {
      outputs.push({ address: feeAddr, amount: feeAmt });
    }

    const txid = await this.agent.sendMultiPayment(outputs);
    console.log(`[BuyerSession] Dual payment sent: ${txid}`);

    await this.agent.client.recordPaymentCombined(this.job.id, txid);
    console.log(`[BuyerSession] Payment + fee recorded`);

    // Wait for payment verification + job to go in_progress
    console.log(`[BuyerSession] Waiting for payment verification...`);
    const maxWaitMs = 15 * 60 * 1000; // 15 min max (6 block confirmations + watcher cycle)
    const startWait = Date.now();
    while (Date.now() - startWait < maxWaitMs) {
      const check = await this.agent.client.getJob(this.job.id);
      if (check.status === 'in_progress') {
        this.job = check;
        console.log(`[BuyerSession] Job in_progress — seller is online`);
        break;
      }
      if (check.status === 'cancelled' || (check.status as string) === 'failed') {
        throw new Error(`Job ${check.status}`);
      }
      await new Promise(r => setTimeout(r, 15000)); // check every 15s
    }
    if (this.job?.status !== 'in_progress') {
      throw new Error('Payment verification timeout — job did not start within 10 minutes');
    }

    // Connect chat
    await this.agent.connectChat();
    this.agent.joinJobChat(this.job.id);

    // Listen for seller messages
    this._messageHandler = (jobId: string, msg: any) => {
      if (jobId !== this.job?.id) return;
      if (msg.senderVerusId === this.agent.address) return; // skip own messages
      this._lastActivity = Date.now();
      this.config.onMessage?.(msg.content, { senderVerusId: msg.senderVerusId, jobId });
    };
    this.agent.onChatMessage(this._messageHandler);

    this._active = true;

    // Idle timer
    if (this.config.autoEndIdleSec && this.config.autoEndIdleSec > 0) {
      this._idleTimer = setInterval(() => {
        const idleSec = (Date.now() - this._lastActivity) / 1000;
        if (idleSec >= this.config.autoEndIdleSec!) {
          this.endSession('idle-timeout');
        }
      }, 10000);
    }

    return this.job;
  }

  /** Send a message to the seller agent */
  async send(message: string): Promise<void> {
    if (!this.job || !this._active) throw new Error('Session not active');
    this._lastActivity = Date.now();
    this.agent.sendChatMessage(this.job.id, message);
  }

  /** Send a message and wait for the seller's response */
  async sendAndWait(message: string, timeoutMs = 60000): Promise<string> {
    if (!this.job || !this._active) throw new Error('Session not active');

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Response timeout'));
      }, timeoutMs);

      const originalHandler = this.config.onMessage;
      this.config.onMessage = (content, meta) => {
        clearTimeout(timer);
        this.config.onMessage = originalHandler;
        originalHandler?.(content, meta);
        resolve(content);
      };

      this.send(message);
    });
  }

  /** Connect the buyer's project directory as a workspace for the seller agent */
  async connectWorkspace(projectDir: string, opts?: {
    permissions?: { read: boolean; write: boolean };
    autoApproveWrites?: boolean;
    onWrite?: (path: string, content: string) => boolean | Promise<boolean>;
    onMcpCall?: (tool: string, path: string) => void;
    /** Override UID for manual testing (if backend endpoint not deployed yet) */
    uid?: string;
  }): Promise<BuyerWorkspace> {
    if (!this.job || !this._active) throw new Error('Session not active');

    this._workspace = new BuyerWorkspace({
      agent: this.agent,
      jobId: this.job.id,
      projectDir,
      permissions: opts?.permissions ?? { read: true, write: true },
      autoApproveWrites: opts?.autoApproveWrites ?? true,
      onWrite: opts?.onWrite,
      onStatusChanged: (status, data) => {
        if (status === 'agent_done') {
          this._lastActivity = Date.now();
        }
        if (status === 'disconnected' || status === 'aborted' || status === 'completed') {
          this._workspace = null;
        }
      },
      onMcpCall: opts?.onMcpCall,
      uid: opts?.uid,
    });

    await this._workspace.connect();
    console.log(`[BuyerSession] Workspace connected — serving ${projectDir}`);
    return this._workspace;
  }

  /** Get the current workspace (null if not connected) */
  get workspace(): BuyerWorkspace | null {
    return this._workspace;
  }

  /** End the session and request delivery */
  async endSession(reason = 'buyer-completed'): Promise<void> {
    if (!this.job || !this._active) return;
    this._active = false;

    // Disconnect workspace first
    if (this._workspace) {
      this._workspace.disconnect();
      this._workspace = null;
    }

    if (this._idleTimer) {
      clearInterval(this._idleTimer);
      this._idleTimer = null;
    }

    try {
      await this.agent.client.requestEndSession(this.job.id, reason);
      console.log(`[BuyerSession] Session ended: ${reason}`);
    } catch (e: any) {
      console.warn(`[BuyerSession] End session failed: ${e.message}`);
    }

    this.config.onSessionEnd?.(reason);
  }

  /** @deprecated — dual payment now sends both in one TX */
  private async _sendFeeInBackground(_feeAddr: string, _feeAmt: number): Promise<void> {
    // No-op: dual payment handles agent + platform fee in a single TX
  }

  /** Get the job object */
  getJob(): Job | null {
    return this.job;
  }

  /** Is the session active? */
  get active(): boolean {
    return this._active;
  }
}
