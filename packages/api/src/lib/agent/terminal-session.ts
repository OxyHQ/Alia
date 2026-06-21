/**
 * Terminal Session — Persistent Shell for Agent Execution
 *
 * Provides a persistent bash session with CWD and env var tracking.
 * The container is lazily created from the pool on first command.
 *
 * This replaces the old pattern of discrete shell_exec tool calls
 * with a stateful terminal where working directory, environment,
 * and installed packages persist between calls.
 */

import { getSandboxProvider, type SandboxProvider, type ExecResult } from '../sandbox/index.js';
import { getContainerPool } from '../sandbox/container-pool.js';
import { Container } from '../../models/container.js';
import { WorkspaceMemory } from './workspace-memory.js';
import { log } from '../logger.js';

const DEFAULT_IMAGE = 'python:3.12';
const DEFAULT_TIMEOUT = 30;
const MAX_TIMEOUT = 300;
const MAX_OUTPUT_CHARS = 16_000;

/** Map of task keyword patterns to preferred Docker images */
const IMAGE_HINTS: Array<{ pattern: RegExp; image: string }> = [
  { pattern: /\b(node|npm|yarn|bun|javascript|typescript|react|next\.?js)\b/i, image: 'node:20' },
  { pattern: /\b(rust|cargo)\b/i, image: 'rust:latest' },
  { pattern: /\b(go|golang)\b/i, image: 'golang:latest' },
  { pattern: /\b(java|maven|gradle|spring)\b/i, image: 'eclipse-temurin:21' },
  { pattern: /\b(ruby|rails|gem)\b/i, image: 'ruby:latest' },
];

/** Infer Docker image from task description */
export function inferImage(task: string, preferredImage?: string): string {
  if (preferredImage) return preferredImage;
  for (const { pattern, image } of IMAGE_HINTS) {
    if (pattern.test(task)) return image;
  }
  return DEFAULT_IMAGE;
}

export class TerminalSession {
  private containerId: string | null = null;
  private cwd = '/workspace';
  private env: Record<string, string> = {};
  private sandbox: SandboxProvider;
  private sessionId: string;
  private agentId: string;
  private userId: string;
  private image: string;
  private workspaceMemory: WorkspaceMemory;
  private onContainerCreated?: (containerId: string) => Promise<void> | void;

  constructor(opts: {
    sessionId: string;
    agentId: string;
    userId: string;
    workspaceMemory: WorkspaceMemory;
    image?: string;
    onContainerCreated?: (containerId: string) => Promise<void> | void;
  }) {
    this.sandbox = getSandboxProvider();
    this.sessionId = opts.sessionId;
    this.agentId = opts.agentId;
    this.userId = opts.userId;
    this.image = opts.image || DEFAULT_IMAGE;
    this.workspaceMemory = opts.workspaceMemory;
    this.onContainerCreated = opts.onContainerCreated;
  }

  /** Get or create the container (lazy provisioning from pool) */
  async ensureContainer(): Promise<string> {
    if (this.containerId) return this.containerId;

    const pool = getContainerPool();
    // Claim from pool WITHOUT persistent flag so we can reuse warm containers.
    // The container is marked persistent in the DB record below, which controls
    // TTL/cleanup behavior without bypassing the warm pool.
    const info = await pool.claim({
      image: this.image,
      size: 'small',
      labels: {
        'alia.session': this.sessionId,
        'alia.agent': this.agentId,
        'alia.user': this.userId,
      },
    });

    this.containerId = info.id;

    // Record in DB
    await Container.create({
      containerId: info.id,
      name: info.name,
      sessionId: this.sessionId,
      agentId: this.agentId,
      userId: this.userId,
      image: this.image,
      size: 'small',
      status: 'running',
      persistent: true,
    });

    // Provision workspace memory structure
    await this.workspaceMemory.provision(info.id);

    if (this.onContainerCreated) {
      try {
        await this.onContainerCreated(info.id);
      } catch (err) {
        log.agents.warn({ err, containerId: info.id, sessionId: this.sessionId }, 'Terminal: failed to run onContainerCreated hook');
      }
    }

    log.agents.info({ containerId: info.id, sessionId: this.sessionId }, 'Terminal: container created');

    return info.id;
  }

  /** Check if a container is active */
  hasContainer(): boolean {
    return this.containerId !== null;
  }

  /** Get the container ID (null if not yet created) */
  getContainerId(): string | null {
    return this.containerId;
  }

  /**
   * Run a bash command in the persistent terminal.
   * Returns raw stdout+stderr combined (like a real terminal).
   */
  async run(command: string, timeout?: number): Promise<string> {
    const id = await this.ensureContainer();
    const timeoutSec = Math.min(timeout || DEFAULT_TIMEOUT, MAX_TIMEOUT);

    // Build the full command with CWD and env
    const envExports = Object.entries(this.env)
      .map(([k, v]) => `export ${k}=${shellEscape(v)}`)
      .join(' && ');

    const fullCommand = [
      envExports,
      `cd ${shellEscape(this.cwd)} 2>/dev/null || cd /workspace`,
      command,
      // Capture the final CWD so we can track it
      'echo "___ALIA_CWD___$(pwd)"',
    ].filter(Boolean).join(' && ');

    const result = await this.sandbox.exec(id, fullCommand, timeoutSec);

    // Track CWD changes
    const output = combineOutput(result);
    const cwdMatch = output.match(/___ALIA_CWD___(.+)/);
    if (cwdMatch) {
      this.cwd = cwdMatch[1].trim();
    }

    // Strip the CWD tracking marker from output
    const cleanOutput = output.replace(/___ALIA_CWD___.+\n?/, '').trimEnd();

    // Track env var changes from export commands
    this.trackEnvChanges(command);

    // Update last activity
    Container.updateOne({ containerId: id }, { lastActivityAt: new Date() }).catch(() => {});

    // Truncate very long output
    if (cleanOutput.length > MAX_OUTPUT_CHARS) {
      return cleanOutput.slice(0, MAX_OUTPUT_CHARS) + `\n\n[Output truncated — ${cleanOutput.length} chars total]`;
    }

    return cleanOutput || '(no output)';
  }

  /** Read a file from the container */
  async readFile(path: string): Promise<string> {
    const id = await this.ensureContainer();
    const absPath = this.resolvePath(path);
    return await this.sandbox.readFile(id, absPath);
  }

  /** Write a file to the container */
  async writeFile(path: string, content: string): Promise<void> {
    const id = await this.ensureContainer();
    const absPath = this.resolvePath(path);
    // Ensure parent directory exists
    const dir = absPath.substring(0, absPath.lastIndexOf('/'));
    if (dir) {
      await this.sandbox.exec(id, `mkdir -p ${shellEscape(dir)}`, 10);
    }
    await this.sandbox.writeFile(id, absPath, content);
  }

  /**
   * Mark the container as idle instead of destroying it.
   * The container persists for `ttlHours` so the user can browse workspace files
   * or resume the session. A background cleanup job handles expiry.
   */
  async idle(ttlHours = 24): Promise<string | null> {
    if (!this.containerId) return null;

    const id = this.containerId;
    try {
      const expiresAt = new Date(Date.now() + ttlHours * 3600_000);
      await Container.updateOne(
        { containerId: id },
        { status: 'idle', persistent: true, expiresAt },
      );
      log.agents.info({ containerId: id, ttlHours }, 'Terminal: container set to idle (persistent)');
    } catch (err) {
      log.agents.warn({ err, containerId: id }, 'Terminal: failed to mark container idle');
    }

    // Don't null out containerId — session document will store it
    return id;
  }

  /**
   * Reattach to an existing container (e.g. when resuming a session).
   */
  async reattach(containerId: string): Promise<boolean> {
    try {
      // Verify container still exists and is running/idle
      const record = await Container.findOne({ containerId, status: { $in: ['running', 'idle'] } });
      if (!record) return false;

      this.containerId = containerId;
      // Mark as running again
      await Container.updateOne({ containerId }, { status: 'running', lastActivityAt: new Date() });
      log.agents.info({ containerId }, 'Terminal: reattached to existing container');
      return true;
    } catch (err) {
      log.agents.warn({ err, containerId }, 'Terminal: failed to reattach');
      return false;
    }
  }

  /** Destroy the container and clean up */
  async destroy(): Promise<void> {
    if (!this.containerId) return;

    try {
      await this.sandbox.destroy(this.containerId);
      await Container.updateOne(
        { containerId: this.containerId },
        { status: 'destroyed', destroyedAt: new Date() },
      );
      log.agents.info({ containerId: this.containerId }, 'Terminal: container destroyed');
    } catch (err) {
      log.agents.warn({ err, containerId: this.containerId }, 'Terminal: failed to destroy container');
    }

    this.containerId = null;
  }

  /** Get current working directory */
  getCwd(): string {
    return this.cwd;
  }

  // ── Internal ──

  private resolvePath(path: string): string {
    if (path.startsWith('/')) return path;
    return `${this.cwd}/${path}`;
  }

  private trackEnvChanges(command: string): void {
    // Simple pattern matching for export VAR=value
    const exportMatches = command.matchAll(/export\s+([A-Za-z_][A-Za-z0-9_]*)=([^\s;]+)/g);
    for (const match of exportMatches) {
      this.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  }
}

/** Combine stdout + stderr like a real terminal */
function combineOutput(result: ExecResult): string {
  const parts: string[] = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) parts.push(result.stderr);

  const combined = parts.join('\n');

  // Include exit code if non-zero (like seeing an error in terminal)
  if (result.exitCode !== 0 && combined) {
    return `${combined}\n[exit code: ${result.exitCode}]`;
  }
  if (result.exitCode !== 0 && !combined) {
    return `[exit code: ${result.exitCode}]`;
  }

  return combined;
}

/** Shell-safe string escaping */
function shellEscape(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}
