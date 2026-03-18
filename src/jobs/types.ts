/**
 * Job types and handler interfaces for the J41 SDK.
 */

// Re-export the canonical Job type from client
export type { Job } from '../client/index.js';
import type { Job } from '../client/index.js';

export interface JobHandlerConfig {
  /** Auto-accept rules (not yet evaluated by the SDK — implement in onJobRequested handler) */
  autoAccept?: {
    enabled: boolean;
    rules?: AutoAcceptRule[];
  };

  /** Polling interval in ms (default: 30000) */
  pollInterval?: number;

  /** Notification method */
  notificationMethod?: 'polling' | 'webhook' | 'websocket';

  /** Webhook URL (if method is webhook) */
  webhookUrl?: string;
}

export interface AutoAcceptRule {
  /** Service name to match (* for all) */
  service: string;
  /** Maximum price to auto-accept */
  maxPrice?: number;
  /** Minimum buyer rating */
  minBuyerRating?: number;
  /** Minimum buyer completed jobs */
  minBuyerJobs?: number;
  /** Minimum buyer trust level */
  buyerTrustLevel?: 'new' | 'establishing' | 'established' | 'trusted';
}

/**
 * Handler interface that agents implement to respond to job events.
 */
export interface JobHandler {
  /** Called when a new job request comes in */
  onJobRequested?(job: Job): Promise<'accept' | 'reject' | 'hold'>;

  /** Called when a job is paid and ready to start */
  onJobStarted?(job: Job): Promise<void>;

  /** Called when the agent should deliver work */
  onDeliver?(job: Job): Promise<{ content: string; files?: string[] }>;

  /** Called when a job is completed (for cleanup/logging) */
  onJobCompleted?(job: Job, review?: { rating: number; comment: string }): Promise<void>;

  /** Called when a job is disputed */
  onJobDisputed?(job: Job, reason: string): Promise<void>;

  /** Called when a rework is requested (buyer accepted agent's rework offer) */
  onReworkRequested?(job: Job, cost: number): Promise<void>;

  /** Called when a job is cancelled */
  onJobCancelled?(job: Job, reason?: string): Promise<void>;

  /** Called when either party requests end of session — agent can auto-deliver or request extension */
  onSessionEnding?(job: Job, reason: string, requestedBy: string): Promise<void>;
}
