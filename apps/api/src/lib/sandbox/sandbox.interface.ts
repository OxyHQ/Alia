/**
 * Sandbox Interface — Provider-Agnostic Container/VM Abstraction
 *
 * Defines a clean interface for sandbox operations that can be
 * implemented by different providers (Docker, E2B, Fly.io, etc.)
 * without changing agent code.
 */

export interface SandboxInfo {
  id: string;
  name: string;
  image: string;
  status: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
}

export interface CreateSandboxOptions {
  image?: string;
  name?: string;
  size?: 'small' | 'medium' | 'large';
  persistent?: boolean;
  labels?: Record<string, string>;
}

export interface SandboxProvider {
  /** Unique provider name (e.g. 'docker', 'e2b') */
  readonly name: string;

  /** Check if this provider is configured and available */
  isAvailable(): boolean;

  /** Create a new sandbox */
  createSandbox(opts: CreateSandboxOptions): Promise<SandboxInfo>;

  /** Execute a command in a sandbox */
  exec(sandboxId: string, command: string, timeoutSeconds?: number): Promise<ExecResult>;

  /** Write a file into the sandbox */
  writeFile(sandboxId: string, path: string, content: string): Promise<void>;

  /** Read a file from the sandbox */
  readFile(sandboxId: string, path: string): Promise<string>;

  /** List files in a directory */
  listFiles(sandboxId: string, dir?: string): Promise<FileEntry[]>;

  /** Expose a port and return the preview URL */
  exposePort(sandboxId: string, port: number): Promise<string>;

  /** Create a snapshot/image of the sandbox */
  snapshot(sandboxId: string, tag: string): Promise<string>;

  /** Destroy a sandbox */
  destroy(sandboxId: string): Promise<void>;

  /** Get sandbox status */
  getStatus(sandboxId: string): Promise<{
    status: string;
    running: boolean;
    startedAt: string;
    image: string;
  }>;

  /** List all sandboxes */
  listAll(): Promise<SandboxInfo[]>;
}
