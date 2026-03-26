/**
 * WorkspaceClient — agent-side workspace relay connection
 *
 * Connects to the platform's /workspace Socket.IO namespace.
 * Sends MCP tool calls (read_file, write_file, list_directory)
 * and receives results from the buyer's CLI.
 */

import { io, Socket } from 'socket.io-client';

/**
 * Validate that a workspace path is safe: relative, no `..` segments, no leading `/`.
 * Throws if invalid.
 */
function assertSafePath(path: string): void {
  if (!path || typeof path !== 'string') {
    throw new Error('Workspace path must be a non-empty string');
  }
  if (path.startsWith('/')) {
    throw new Error(`Workspace path must be relative, not absolute: "${path}"`);
  }
  const parts = path.split(/[\\/]/);
  if (parts.some(p => p === '..')) {
    throw new Error(`Workspace path must not contain ".." traversal: "${path}"`);
  }
}

export interface WorkspaceClientConfig {
  apiUrl: string;
  getSessionToken: () => string | null;
}

export interface WorkspaceStatus {
  jobId: string;
  status: 'pending' | 'active' | 'completed' | 'aborted';
  agentConnected: boolean;
  buyerConnected: boolean;
  createdAt: string;
  updatedAt: string;
  stats?: {
    filesRead: number;
    filesWritten: number;
    listDirectoryCalls: number;
  };
}

export interface WorkspaceToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export interface WorkspaceStats {
  filesRead: number;
  filesWritten: number;
  listDirectoryCalls: number;
  duration: number;
}

export class WorkspaceClient {
  private config: WorkspaceClientConfig;
  private socket: Socket | null = null;
  private requestId = 0;
  private pendingRequests = new Map<string, {
    resolve: (result: any) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private statusHandler: ((status: string, data?: any) => void) | null = null;
  private disconnectHandler: ((reason: string) => void) | null = null;
  private _connected = false;
  private _jobId: string | null = null;
  private _stats = {
    filesRead: 0,
    filesWritten: 0,
    listDirectoryCalls: 0,
    connectedAt: 0,
  };

  constructor(config: WorkspaceClientConfig) {
    this.config = config;
  }

  /**
   * Connect to the workspace relay for a specific job.
   * Gets a one-time connect token via REST, then connects Socket.IO.
   * Resolves when the buyer's CLI is connected (status: active).
   */
  async connect(jobId: string): Promise<void> {
    this._jobId = jobId;

    // Step 1: Get connect token via REST — use live token getter (C1 fix)
    const tokenController = new AbortController();
    const tokenTimer = setTimeout(() => tokenController.abort(), 15_000);
    let tokenRes: Response;
    try {
      tokenRes = await fetch(`${this.config.apiUrl}/v1/workspace/${jobId}/connect-token`, {
        headers: {
          'Cookie': `verus_session=${this.config.getSessionToken()}`,
        },
        credentials: 'include',
        signal: tokenController.signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error('Workspace connect-token request timed out after 15s');
      }
      throw err;
    } finally {
      clearTimeout(tokenTimer);
    }

    if (!tokenRes.ok) {
      const err = await tokenRes.json().catch(() => ({}));
      throw new Error((err as any).error?.message || `Failed to get connect token: ${tokenRes.status}`);
    }

    const { data } = await tokenRes.json();
    const { token, wsUrl } = data;

    // Step 2: Extract origin from wsUrl (strip /ws path if present)
    const origin = wsUrl.replace(/\/ws\/?$/, '');

    // Step 3: Connect Socket.IO to /workspace namespace
    return new Promise<void>((resolve, reject) => {
      let settled = false;

      this.socket = io(origin + '/workspace', {
        path: '/ws',
        auth: { type: 'agent', token },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 2000,
        reconnectionAttempts: 10,
      });

      this.socket.on('connect', () => {
        this._connected = true;
        this._stats.connectedAt = Date.now();
        // Don't resolve yet — wait for workspace to be active
      });

      this.socket.on('connect_error', (err) => {
        if (!settled) {
          settled = true;
          reject(new Error(`Workspace connection failed: ${err.message}`));
        }
      });

      // MCP results from buyer's CLI
      this.socket.on('mcp:result', (data: any) => {
        const pending = this.pendingRequests.get(data.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(data.id);
          if (data.success) {
            pending.resolve(data.result);
          } else {
            pending.reject(new Error(data.error || 'Tool call failed'));
          }
        }
      });

      // Status changes
      this.socket.on('workspace:status_changed', (data: { status: string; reason?: string }) => {
        if (data.status === 'active' && !settled) {
          settled = true;
          resolve(); // Buyer connected — workspace is ready
        }
        this.statusHandler?.(data.status, data);

        // Auto-cleanup on terminal states
        if (data.status === 'aborted' || data.status === 'completed') {
          this._connected = false;
        }
      });

      this.socket.on('ws:error', (data: { code: string; message: string }) => {
        if (!settled) {
          settled = true;
          reject(new Error(`Relay error: ${data.message}`));
        }
      });

      this.socket.on('disconnect', (reason) => {
        this._connected = false;
        this.disconnectHandler?.(reason);
      });

      // Timeout — if buyer doesn't connect within 5 minutes
      setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('Timeout waiting for buyer to connect workspace CLI'));
          this.disconnect();
        }
      }, 5 * 60 * 1000);
    });
  }

  /**
   * Low-level: send an MCP tool call and wait for result.
   * The tool name should NOT have workspace_ prefix — use the raw MCP tool name
   * (read_file, write_file, list_directory).
   */
  async sendToolCall(tool: string, params: Record<string, any>): Promise<any> {
    if (!this.socket || !this._connected) {
      throw new Error('Workspace not connected');
    }

    const id = `ws-${++this.requestId}`;

    return new Promise((resolve, reject) => {
      // No timeout on writes — buyer reviews + approves in supervised mode
      const timeoutMs = tool === 'write_file' ? 0 : 30_000;
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Tool call timeout: ${tool}`));
      }, timeoutMs || 2_147_483_647); // ~24 days = effectively no timeout for writes

      this.pendingRequests.set(id, { resolve, reject, timeout });

      this.socket!.emit('mcp:call', { id, tool, params });
    });
  }

  // ── High-level tool methods ───────────────────────────────────

  async listDirectory(path: string = '.'): Promise<any[]> {
    assertSafePath(path);
    this._stats.listDirectoryCalls++;
    const result = await this.sendToolCall('list_directory', { path });
    try {
      return JSON.parse(result.content[0].text);
    } catch {
      return result;
    }
  }

  async readFile(path: string): Promise<string> {
    assertSafePath(path);
    this._stats.filesRead++;
    const result = await this.sendToolCall('read_file', { path });
    if (!result?.content?.[0]?.text) {
      throw new Error(`readFile: unexpected MCP result format for path "${path}"`);
    }
    return result.content[0].text;
  }

  async writeFile(path: string, content: string): Promise<string> {
    assertSafePath(path);
    this._stats.filesWritten++;
    const result = await this.sendToolCall('write_file', { path, content });
    if (!result?.content?.[0]?.text) {
      throw new Error(`writeFile: unexpected MCP result format for path "${path}"`);
    }
    return result.content[0].text;
  }

  /** Signal to the buyer that the agent's work is complete */
  signalDone(): void {
    this.socket?.emit('workspace:agent_done');
  }

  /** Get workspace usage stats for attestation */
  getStats(): WorkspaceStats {
    return {
      filesRead: this._stats.filesRead,
      filesWritten: this._stats.filesWritten,
      listDirectoryCalls: this._stats.listDirectoryCalls,
      duration: this._stats.connectedAt
        ? Math.floor((Date.now() - this._stats.connectedAt) / 1000)
        : 0,
    };
  }

  // ── Event handlers ────────────────────────────────────────────

  onStatusChanged(handler: (status: string, data?: any) => void): void {
    this.statusHandler = handler;
  }

  onDisconnected(handler: (reason: string) => void): void {
    this.disconnectHandler = handler;
  }

  // ── Tool definitions for executor injection ───────────────────

  getAvailableTools(): WorkspaceToolDef[] {
    return [
      {
        type: 'function',
        function: {
          name: 'workspace_list_directory',
          description: 'List files and directories in the buyer\'s project',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Relative path (default: root)' } },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'workspace_read_file',
          description: 'Read a file from the buyer\'s project',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Relative path to file' } },
            required: ['path'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'workspace_write_file',
          description: 'Write content to a file in the buyer\'s project',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative path to file' },
              content: { type: 'string', description: 'File content to write' },
            },
            required: ['path', 'content'],
          },
        },
      },
    ];
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  get isConnected(): boolean {
    return this._connected;
  }

  get jobId(): string | null {
    return this._jobId;
  }

  disconnect(): void {
    this._stats = { filesRead: 0, filesWritten: 0, listDirectoryCalls: 0, connectedAt: 0 };
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Workspace disconnected'));
    }
    this.pendingRequests.clear();
    this.socket?.disconnect();
    this.socket = null;
    this._connected = false;
    this._jobId = null;
  }
}
