/**
 * SovGuard WebSocket client for J41 agents.
 * Connects to the platform's Socket.IO chat server.
 */

import { io, Socket } from 'socket.io-client';

export interface ChatClientConfig {
  /** Base URL of the J41 API (e.g. https://api.autobb.app) */
  apiUrl: string;
  /** Session cookie value (verus_session) */
  sessionToken: string;
}

export interface IncomingMessage {
  id: string;
  jobId: string;
  senderVerusId: string;
  content: string;
  signed: boolean;
  safetyScore: number | null;
  createdAt: string;
}

export interface SessionEndingEvent {
  jobId: string;
  requestedBy: string;
  reason: string;
  timestamp: string;
}

export interface SessionExpiringEvent {
  jobId: string;
  expiresAt: string;
  remainingSeconds: number;
}

export interface JobStatusChangedEvent {
  jobId: string;
  status: string;
  reason?: string;
}

export interface ReviewReceivedEvent {
  inboxId: string;
  jobHash: string;
  rating: number | null;
  buyerVerusId: string;
}

export type MessageHandler = (message: IncomingMessage) => void | Promise<void>;
export type SessionEndingHandler = (event: SessionEndingEvent) => void | Promise<void>;
export type SessionExpiringHandler = (event: SessionExpiringEvent) => void | Promise<void>;
export type JobStatusChangedHandler = (event: JobStatusChangedEvent) => void | Promise<void>;
export type ReviewReceivedHandler = (event: ReviewReceivedEvent) => void | Promise<void>;

/** Safely invoke any async/sync callback, catching both sync throws and async rejections */
function safeCall(fn: () => void | Promise<void>): void {
  try {
    const result = fn();
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch((e) => console.error('[CHAT] Async handler error:', e));
    }
  } catch (e) {
    console.error('[CHAT] Handler error:', e);
  }
}

/** Maximum outbound message size (64 KB) */
const MAX_MESSAGE_SIZE = 64 * 1024;

export class ChatClient {
  private socket: Socket | null = null;
  private config: ChatClientConfig;
  private joinedRooms = new Set<string>();
  private messageHandlers = new Map<string, MessageHandler[]>(); // jobId -> handlers
  private globalHandler: MessageHandler | null = null;
  private sessionEndingHandler: SessionEndingHandler | null = null;
  private sessionExpiringHandler: SessionExpiringHandler | null = null;
  private jobStatusChangedHandler: JobStatusChangedHandler | null = null;
  private reviewReceivedHandler: ReviewReceivedHandler | null = null;
  /** Callback invoked when auto-reconnect fails permanently (S4) */
  onReconnectFailed: ((error: Error) => void) | null = null;

  constructor(config: ChatClientConfig) {
    this.config = config;
  }

  /**
   * Connect to the chat server.
   * Gets a one-time token first, then establishes WebSocket.
   */
  async connect(): Promise<void> {
    // Clean up any existing socket before reconnecting
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }

    // Step 1: Get a one-time chat token via REST API
    const tokenController = new AbortController();
    const tokenTimer = setTimeout(() => tokenController.abort(), 15_000);
    let tokenRes: Response;
    try {
      tokenRes = await fetch(`${this.config.apiUrl}/v1/chat/token`, {
        headers: {
          'Cookie': `verus_session=${this.config.sessionToken}`,
        },
        signal: tokenController.signal,
      });
    } catch (err) {
      clearTimeout(tokenTimer);
      if ((err as Error).name === 'AbortError') {
        throw new Error('Chat token request timed out after 15s');
      }
      throw err;
    } finally {
      clearTimeout(tokenTimer);
    }

    if (!tokenRes.ok) {
      throw new Error(`Failed to get chat token: ${tokenRes.status}`);
    }

    const tokenData = (await tokenRes.json()) as { data?: { token?: string } };
    const chatToken = tokenData.data?.token;
    if (!chatToken) {
      throw new Error('No chat token in response');
    }

    // Step 2: Connect Socket.IO with the token
    return new Promise((resolve, reject) => {
      let resolved = false;

      this.socket = io(this.config.apiUrl, {
        path: '/ws',
        auth: { token: chatToken },
        extraHeaders: {
          'Cookie': `verus_session=${this.config.sessionToken}`,
        },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 2000,
        reconnectionAttempts: 10,
      });

      // Timeout if connection takes too long
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.socket?.disconnect();
          reject(new Error('Chat connection timeout'));
        }
      }, 10000);

      this.socket.on('connect', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          // Re-join any rooms we were in
          for (const jobId of this.joinedRooms) {
            this.socket?.emit('join_job', { jobId });
          }
          resolve();
        }
      });

      this.socket.on('disconnect', (reason: string) => {
        console.log(`[CHAT] Disconnected: ${reason}`);
      });

      this.socket.on('connect_error', (err: Error) => {
        console.error(`[CHAT] Connection error: ${err.message}`);
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          reject(err);
        }
      });

      this.socket.on('message', (msg: IncomingMessage) => {
        // Snapshot handlers to avoid mutation during iteration
        const handlers = this.messageHandlers.get(msg.jobId);
        if (handlers) {
          const snapshot = [...handlers];
          for (const h of snapshot) {
            safeCall(() => h(msg));
          }
        }
        // Route to global handler
        const global = this.globalHandler;
        if (global) {
          safeCall(() => global(msg));
        }
      });

      this.socket.on('joined', (data: { jobId: string; room: string }) => {
        console.log(`[CHAT] Joined room for job ${data.jobId}`);
      });

      this.socket.on('error', (data: { message: string }) => {
        console.error(`[CHAT] Server error: ${data.message}`);
      });

      this.socket.on('reconnect_failed', () => {
        console.error('[CHAT] All reconnection attempts failed — getting fresh token...');
        this.connect().catch((err) => {
          console.error('[CHAT] Auto-reconnect failed:', err.message);
          // S4: Surface failure via callback so J41Agent can handle it
          if (this.onReconnectFailed) {
            this.onReconnectFailed(err);
          }
        });
      });

      this.socket.on('session_ending', (data: SessionEndingEvent) => {
        const handler = this.sessionEndingHandler;
        if (handler) {
          safeCall(() => handler(data));
        }
      });

      this.socket.on('session_expiring', (data: SessionExpiringEvent) => {
        const handler = this.sessionExpiringHandler;
        if (handler) {
          safeCall(() => handler(data));
        }
      });

      this.socket.on('job_status_changed', (data: JobStatusChangedEvent) => {
        const handler = this.jobStatusChangedHandler;
        if (handler) {
          safeCall(() => handler(data));
        }
      });

      this.socket.on('review_received', (data: ReviewReceivedEvent) => {
        const handler = this.reviewReceivedHandler;
        if (handler) {
          safeCall(() => handler(data));
        }
      });
    });
  }

  /**
   * Join a job's chat room.
   */
  joinJob(jobId: string): void {
    this.joinedRooms.add(jobId);
    if (this.socket?.connected) {
      this.socket.emit('join_job', { jobId });
    }
  }

  /**
   * Leave a job's chat room.
   */
  leaveJob(jobId: string): void {
    this.joinedRooms.delete(jobId);
    this.messageHandlers.delete(jobId);
    if (this.socket?.connected) {
      this.socket.emit('leave_job', { jobId });
    }
  }

  /**
   * Send a message in a job chat.
   */
  sendMessage(jobId: string, content: string, signature?: string): void {
    if (!this.socket?.connected) {
      throw new Error('Not connected to chat');
    }
    const byteLength = new TextEncoder().encode(content).byteLength;
    if (byteLength > MAX_MESSAGE_SIZE) {
      throw new Error(`Message exceeds maximum size of ${MAX_MESSAGE_SIZE} bytes (got ${byteLength})`);
    }
    this.socket.emit('message', { jobId, content, signature });
  }

  /**
   * Register a handler for messages in a specific job.
   */
  onJobMessage(jobId: string, handler: MessageHandler): void {
    const existing = this.messageHandlers.get(jobId) || [];
    existing.push(handler);
    this.messageHandlers.set(jobId, existing);
  }

  /**
   * Register a handler for all messages across all jobs.
   */
  onMessage(handler: MessageHandler): void {
    this.globalHandler = handler;
  }

  /**
   * Register a handler for session ending events.
   * Fired when either party calls POST /v1/jobs/:id/end-session.
   */
  onSessionEnding(handler: SessionEndingHandler): void {
    this.sessionEndingHandler = handler;
  }

  /**
   * Register a handler for session expiring events.
   * Fired 2 minutes before session timeout.
   */
  onSessionExpiring(handler: SessionExpiringHandler): void {
    this.sessionExpiringHandler = handler;
  }

  /**
   * Register a handler for job status change events.
   * Fired on job state transitions (deliver, complete, etc.).
   */
  onJobStatusChanged(handler: JobStatusChangedHandler): void {
    this.jobStatusChangedHandler = handler;
  }

  /**
   * Register a handler for review received events.
   * Fired when a buyer submits a review that goes to the agent's inbox.
   */
  onReviewReceived(handler: ReviewReceivedHandler): void {
    this.reviewReceivedHandler = handler;
  }

  /**
   * Send a typing indicator.
   */
  sendTyping(jobId: string): void {
    if (this.socket?.connected) {
      this.socket.emit('typing', { jobId });
    }
  }

  /**
   * Mark messages as read.
   */
  markRead(jobId: string): void {
    if (this.socket?.connected) {
      this.socket.emit('read', { jobId });
    }
  }

  /**
   * Check if connected (uses Socket.IO's own state as source of truth).
   */
  get isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  /**
   * Disconnect from chat.
   */
  disconnect(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
    }
    this.socket = null;
    this.joinedRooms.clear();
    this.messageHandlers.clear();
    this.globalHandler = null;
    this.sessionEndingHandler = null;
    this.sessionExpiringHandler = null;
    this.jobStatusChangedHandler = null;
    this.reviewReceivedHandler = null;
  }
}
