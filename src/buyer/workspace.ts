/**
 * BuyerWorkspace — programmatic workspace relay for agent-to-agent jobs.
 *
 * Acts as the buyer side of the workspace relay, identical to j41-jailbox
 * but running in-process (no Docker, no interactive prompts).
 * Serves files from a local project directory to the seller agent
 * via the platform's /jailbox Socket.IO namespace.
 */

import { readdirSync, readFileSync, writeFileSync, statSync, existsSync, mkdirSync } from 'fs';
import { join, resolve, relative } from 'path';
import { createHash } from 'crypto';
import { io, Socket } from 'socket.io-client';
import type { J41Agent } from '../agent.js';

// ── Constants (match j41-jailbox) ──────────────────────────────

const MAX_FILE_SIZE = 10 * 1024 * 1024;         // 10MB
const MAX_DIR_ENTRIES = 10_000;
const MAX_SESSION_TRANSFER = 500 * 1024 * 1024;  // 500MB
const KEEPALIVE_INTERVAL_MS = 30_000;             // 30s

const AUTO_EXCLUDE_PATTERNS = [
  '.env', '.env.*',
  '.ssh/', '.gnupg/',
  '*.pem', '*.key', '*.p12',
  'credentials.json', 'secrets.*',
  'node_modules/', '.git/',
  '.DS_Store', 'Thumbs.db',
];

// ── Types ──────────────────────────────────────────────────────

export interface BuyerWorkspaceConfig {
  /** The buyer agent instance (authenticated) */
  agent: J41Agent;
  /** Job ID for the workspace session */
  jobId: string;
  /** Project directory to serve to the seller agent */
  projectDir: string;
  /** File permissions (default: { read: true, write: true }) */
  permissions?: { read: boolean; write: boolean };
  /** Auto-approve writes without callback (default: true for agent-to-agent) */
  autoApproveWrites?: boolean;
  /** Custom write gate — return false to reject */
  onWrite?: (path: string, content: string) => boolean | Promise<boolean>;
  /** Status change callback */
  onStatusChanged?: (status: string, data?: any) => void;
  /** Audit callback for MCP tool calls */
  onMcpCall?: (tool: string, path: string) => void;
  /** Override UID (for testing with manually-generated UIDs) */
  uid?: string;
}

interface ExclusionEntry {
  path: string;
  reason: string;
}

type OperationType = 'read' | 'write' | 'list_dir' | 'read_file' | 'write_file' | 'list_directory';

interface OperationMetadata {
  operation: OperationType | string;
  path: string;
  sizeBytes?: number;
  contentHash?: string;
  sovguardScore: number;
  approved?: boolean;
  blocked?: boolean;
  blockReason?: string;
}

export interface BuyerWorkspaceStats {
  reads: number;
  writes: number;
  listDirs: number;
  totalBytes: number;
  startedAt: number;
}

// ── Pre-scan helpers (ported from j41-jailbox) ─────────────────

function shouldExclude(relPath: string, isDir: boolean): boolean {
  const name = relPath.split('/').pop() || '';
  for (const pattern of AUTO_EXCLUDE_PATTERNS) {
    if (pattern.endsWith('/') && isDir && name === pattern.slice(0, -1)) return true;
    if (pattern.startsWith('*.') && name.endsWith(pattern.slice(1))) return true;
    if (name === pattern) return true;
    if (pattern.endsWith('*') && name.startsWith(pattern.slice(0, -1))) return true;
  }
  return false;
}

function getExcludeReason(relPath: string): string {
  const name = relPath.split('/').pop() || '';
  if (name.startsWith('.env')) return 'environment variables';
  if (name === '.ssh' || name === '.gnupg') return 'cryptographic keys';
  if (name.endsWith('.pem') || name.endsWith('.key') || name.endsWith('.p12')) return 'certificates/keys';
  if (name === 'credentials.json' || name.startsWith('secrets')) return 'credentials';
  if (name === 'node_modules') return 'too large';
  if (name === '.git') return 'version control';
  if (name === '.DS_Store' || name === 'Thumbs.db') return 'OS metadata';
  return 'auto-excluded';
}

function walkDir(
  rootDir: string,
  currentDir: string,
  files: string[],
  exclusions: ExclusionEntry[],
): void {
  let entries;
  try {
    entries = readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    const relPath = relative(rootDir, fullPath);
    if (shouldExclude(relPath, entry.isDirectory())) {
      exclusions.push({
        path: relPath + (entry.isDirectory() ? '/' : ''),
        reason: getExcludeReason(relPath),
      });
      continue;
    }
    if (entry.isDirectory()) {
      walkDir(rootDir, fullPath, files, exclusions);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
}

function isExcluded(relPath: string, exclusions: ExclusionEntry[]): boolean {
  return exclusions.some((ex) => {
    const exPath = ex.path.replace(/\/$/, '');
    return relPath === exPath || relPath.startsWith(exPath + '/');
  });
}

function isBinary(buffer: Buffer): boolean {
  const check = buffer.subarray(0, 8192);
  for (let i = 0; i < check.length; i++) {
    if (check[i] === 0) return true;
  }
  return false;
}

// ── BuyerWorkspace class ───────────────────────────────────────

export class BuyerWorkspace {
  private config: BuyerWorkspaceConfig;
  private socket: Socket | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private exclusions: ExclusionEntry[] = [];
  private _connected = false;
  private _sessionTransferBytes = 0;
  private _stats: BuyerWorkspaceStats = {
    reads: 0, writes: 0, listDirs: 0, totalBytes: 0, startedAt: 0,
  };

  constructor(config: BuyerWorkspaceConfig) {
    this.config = {
      permissions: { read: true, write: true },
      autoApproveWrites: true,
      ...config,
    };
  }

  /**
   * Connect to the workspace relay as the buyer.
   * Pre-scans the project directory, obtains a workspace UID,
   * and establishes the Socket.IO connection.
   */
  async connect(): Promise<void> {
    const { projectDir } = this.config;

    // Validate directory
    if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
      throw new Error(`Not a valid directory: ${projectDir}`);
    }

    // Pre-scan: collect exclusions + directory hash
    const allFiles: string[] = [];
    this.exclusions = [];
    walkDir(projectDir, projectDir, allFiles, this.exclusions);

    const hashInput = allFiles.map((f) => {
      const rel = relative(projectDir, f);
      try { return `${rel}:${statSync(f).size}`; } catch { return rel; }
    }).sort().join('\n');
    const directoryHash = createHash('sha256').update(hashInput).digest('hex');

    if (this.exclusions.length > 0) {
      console.log(`[BuyerWorkspace] Excluded ${this.exclusions.length} items: ${this.exclusions.map(e => e.path).join(', ')}`);
    }

    // Get jailbox UID from backend (POST /v1/jailbox/{jobId}/token)
    let uid = this.config.uid;
    if (!uid) {
      const result = await this.config.agent.client.initBuyerWorkspace(this.config.jobId);
      uid = result.workspaceUid;
    }
    if (!uid) {
      throw new Error('No workspace UID in token response. Use config.uid for manual testing.');
    }

    // Connect Socket.IO to /jailbox namespace
    const apiUrl = this.config.agent.client.getBaseUrl();

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      this.socket = io(apiUrl + '/jailbox', {
        path: '/ws',
        auth: { type: 'buyer', uid },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 2000,
      });

      this.socket.on('connect', () => {
        this._connected = true;
        this._stats.startedAt = Date.now();

        // Send pre-scan data
        this.socket!.emit('jailbox:pre_scan_done', {
          directoryHash,
          excludedFiles: this.exclusions.map((e) => e.path),
        });

        // Start keepalive
        this.startKeepalive();

        console.log(`[BuyerWorkspace] Connected — serving ${allFiles.length} files from ${projectDir}`);
        if (!settled) { settled = true; resolve(); }
      });

      this.socket.on('connect_error', (err) => {
        if (!settled) { settled = true; reject(new Error(`Workspace connection failed: ${err.message}`)); }
      });

      // MCP tool calls from the seller agent (via relay)
      this.socket.on('mcp:call', (data: { id: string; tool: string; params: Record<string, any> }) => {
        this.handleMcpCall(data).catch((err) => {
          console.warn(`[BuyerWorkspace] MCP call error: ${err.message}`);
        });
      });

      // Status changes
      this.socket.on('jailbox:status_changed', (data: { status: string; reason?: string }) => {
        this.config.onStatusChanged?.(data.status, data);
        if (data.status === 'aborted' || data.status === 'completed') {
          this._connected = false;
        }
      });

      // Agent signals completion
      this.socket.on('jailbox:agent_done', () => {
        this.config.onStatusChanged?.('agent_done', {});
      });

      // Agent disconnected
      this.socket.on('jailbox:agent_disconnected', (data: any) => {
        this.config.onStatusChanged?.('agent_disconnected', data);
      });

      // Relay errors
      this.socket.on('ws:error', (data: { code: string; message: string }) => {
        console.warn(`[BuyerWorkspace] Relay error: ${data.message}`);
        if (!settled) { settled = true; reject(new Error(`Relay error: ${data.message}`)); }
      });

      this.socket.on('disconnect', (reason) => {
        this._connected = false;
        this.stopKeepalive();
        this.config.onStatusChanged?.('disconnected', { reason });
      });

      this.socket.on('reconnect', () => {
        this._connected = true;
        this.startKeepalive();
        this.config.onStatusChanged?.('reconnected', {});
        console.log('[BuyerWorkspace] Reconnected to relay');
      });

      // Timeout — if connection doesn't establish within 30s
      setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('Workspace connection timeout (30s)'));
          this.disconnect();
        }
      }, 30_000);
    });
  }

  /** Disconnect from the workspace relay */
  disconnect(): void {
    this.stopKeepalive();
    this.socket?.disconnect();
    this.socket = null;
    this._connected = false;
  }

  /** Is the workspace connected? */
  get isConnected(): boolean {
    return this._connected;
  }

  /** Get workspace usage stats */
  getStats(): BuyerWorkspaceStats {
    return { ...this._stats };
  }

  // ── MCP call handler ──────────────────────────────────────────

  private async handleMcpCall(call: { id: string; tool: string; params: Record<string, any> }): Promise<void> {
    const { id, tool, params } = call;
    const relPath = params?.path || '.';

    // Audit callback
    this.config.onMcpCall?.(tool, relPath);

    // Permission check
    if (tool === 'write_file' && !this.config.permissions!.write) {
      this.sendResult(id, false, undefined, 'Write permission not granted', {
        operation: 'write', path: relPath, sovguardScore: 0, blocked: true,
        blockReason: 'write permission not granted',
      });
      return;
    }

    // Exclusion check
    if (isExcluded(relPath, this.exclusions)) {
      this.sendResult(id, false, undefined, 'File is excluded from workspace', {
        operation: tool, path: relPath, sovguardScore: 0, blocked: true,
        blockReason: 'excluded file',
      });
      return;
    }

    // Transfer limit
    if (this._sessionTransferBytes > MAX_SESSION_TRANSFER) {
      this.sendResult(id, false, undefined, 'Session transfer limit exceeded (500MB)', {
        operation: tool, path: relPath, sovguardScore: 0, blocked: true,
        blockReason: 'session transfer limit exceeded',
      });
      return;
    }

    // Write gate
    if (tool === 'write_file') {
      if (!this.config.autoApproveWrites && this.config.onWrite) {
        const approved = await this.config.onWrite(relPath, params.content);
        if (!approved) {
          this.sendResult(id, false, undefined, 'Write rejected by buyer agent', {
            operation: 'write', path: relPath, sovguardScore: 0,
            approved: false,
          });
          return;
        }
      }
    }

    // Execute tool
    try {
      switch (tool) {
        case 'list_directory':
          this.execListDirectory(id, relPath);
          break;
        case 'read_file':
          this.execReadFile(id, relPath);
          break;
        case 'write_file':
          this.execWriteFile(id, relPath, params.content);
          break;
        default:
          this.sendResult(id, false, undefined, `Unknown tool: ${tool}`, {
            operation: tool, path: relPath, sovguardScore: 0, blocked: true,
            blockReason: 'unknown tool',
          });
      }
    } catch (err: any) {
      this.sendResult(id, false, undefined, err.message, {
        operation: tool, path: relPath, sovguardScore: 0, blocked: true,
        blockReason: err.message,
      });
    }
  }

  // ── Tool implementations ──────────────────────────────────────

  private execListDirectory(callId: string, relPath: string): void {
    const absPath = this.resolveSafe(relPath);
    if (!absPath) {
      this.sendResult(callId, false, undefined, 'Path is outside the project directory', {
        operation: 'list_dir', path: relPath, sovguardScore: 0, blocked: true,
        blockReason: 'path traversal',
      });
      return;
    }

    if (!existsSync(absPath) || !statSync(absPath).isDirectory()) {
      this.sendResult(callId, false, undefined, `Not a directory: ${relPath}`, {
        operation: 'list_dir', path: relPath, sovguardScore: 0, blocked: true,
        blockReason: 'not a directory',
      });
      return;
    }

    const entries = readdirSync(absPath, { withFileTypes: true });
    const result = entries.slice(0, MAX_DIR_ENTRIES).map((e) => ({
      name: e.name,
      type: e.isDirectory() ? 'directory' : 'file',
      size: e.isFile() ? statSync(join(absPath, e.name)).size : undefined,
    }));

    this._stats.listDirs++;
    this.sendResult(callId, true, {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      _meta: { entryCount: result.length, path: relPath },
    }, undefined, {
      operation: 'list_dir', path: relPath, sovguardScore: 0,
    });
  }

  private execReadFile(callId: string, relPath: string): void {
    const absPath = this.resolveSafe(relPath);
    if (!absPath) {
      this.sendResult(callId, false, undefined, 'Path is outside the project directory', {
        operation: 'read', path: relPath, sovguardScore: 0, blocked: true,
        blockReason: 'path traversal',
      });
      return;
    }

    if (!existsSync(absPath) || !statSync(absPath).isFile()) {
      this.sendResult(callId, false, undefined, `File not found: ${relPath}`, {
        operation: 'read', path: relPath, sovguardScore: 0, blocked: true,
        blockReason: 'file not found',
      });
      return;
    }

    const stat = statSync(absPath);
    if (stat.size > MAX_FILE_SIZE) {
      this.sendResult(callId, false, undefined, `File too large: ${stat.size} bytes (max ${MAX_FILE_SIZE})`, {
        operation: 'read', path: relPath, sovguardScore: 0, blocked: true,
        blockReason: 'file too large',
      });
      return;
    }

    const buffer = readFileSync(absPath);
    if (isBinary(buffer)) {
      this.sendResult(callId, false, undefined, 'Binary files are not supported', {
        operation: 'read', path: relPath, sovguardScore: 0, blocked: true,
        blockReason: 'binary file',
      });
      return;
    }

    const text = buffer.toString('utf-8');
    const hash = createHash('sha256').update(buffer).digest('hex');

    this._stats.reads++;
    this._stats.totalBytes += stat.size;
    this._sessionTransferBytes += stat.size;

    this.sendResult(callId, true, {
      content: [{ type: 'text', text }],
      _meta: { sizeBytes: stat.size, contentHash: `sha256:${hash}`, path: relPath },
    }, undefined, {
      operation: 'read', path: relPath, sizeBytes: stat.size,
      contentHash: `sha256:${hash}`, sovguardScore: 0,
    });
  }

  private execWriteFile(callId: string, relPath: string, content: string): void {
    const absPath = this.resolveSafe(relPath);
    if (!absPath) {
      this.sendResult(callId, false, undefined, 'Path is outside the project directory', {
        operation: 'write', path: relPath, sovguardScore: 0, blocked: true,
        blockReason: 'path traversal',
      });
      return;
    }

    const contentBuffer = Buffer.from(content, 'utf-8');
    if (contentBuffer.length > MAX_FILE_SIZE) {
      this.sendResult(callId, false, undefined, `Content too large: ${contentBuffer.length} bytes (max ${MAX_FILE_SIZE})`, {
        operation: 'write', path: relPath, sovguardScore: 0, blocked: true,
        blockReason: 'content too large',
      });
      return;
    }

    // Ensure parent directory exists
    const parentDir = resolve(absPath, '..');
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    writeFileSync(absPath, content, 'utf-8');
    const hash = createHash('sha256').update(contentBuffer).digest('hex');

    this._stats.writes++;
    this._stats.totalBytes += contentBuffer.length;
    this._sessionTransferBytes += contentBuffer.length;

    this.sendResult(callId, true, {
      content: [{ type: 'text', text: `Written: ${relPath} (${contentBuffer.length} bytes)` }],
      _meta: { sizeBytes: contentBuffer.length, contentHash: `sha256:${hash}`, path: relPath },
    }, undefined, {
      operation: 'write', path: relPath, sizeBytes: contentBuffer.length,
      contentHash: `sha256:${hash}`, sovguardScore: 0, approved: true,
    });
  }

  // ── Helpers ───────────────────────────────────────────────────

  private resolveSafe(relPath: string): string | null {
    if (relPath.includes('..')) return null;
    const root = resolve(this.config.projectDir);
    const absPath = resolve(root, relPath);
    if (!absPath.startsWith(root + '/') && absPath !== root) return null;
    return absPath;
  }

  private sendResult(
    id: string,
    success: boolean,
    result?: any,
    error?: string,
    metadata?: OperationMetadata,
  ): void {
    this.socket?.emit('mcp:result', {
      id,
      success,
      result: success ? result : undefined,
      error: success ? undefined : error,
      metadata: metadata || { operation: 'unknown', path: '', sovguardScore: 0 },
    });
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (this._connected) {
        this.socket?.emit('jailbox:ping');
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }
}
