/**
 * Workspace Memory — File-System-as-Extended-Context
 *
 * Implements Manus's key insight: the container filesystem is unlimited,
 * persistent, agent-operable context. When tool results are too large
 * for the context window, they're offloaded to the workspace and
 * replaced with a reference the agent can re-read later.
 *
 * Directory structure in containers:
 *   /workspace/.alia/
 *     todo.md           — Rendered todo list (synced from TodoManager)
 *     observations/     — Offloaded large tool results
 *     scripts/          — Executed scripts (for CodeAct, Phase 2)
 *     summary.md        — Running summary of session
 */

import * as containerManager from '../container-manager.js';
import { log } from '../logger.js';

/** Token threshold above which results are offloaded to filesystem */
const OFFLOAD_THRESHOLD_TOKENS = 4000;
const CHARS_PER_TOKEN = 4;
const OFFLOAD_THRESHOLD_CHARS = OFFLOAD_THRESHOLD_TOKENS * CHARS_PER_TOKEN;

export interface OffloadResult {
  wasOffloaded: boolean;
  content: string;         // Either original content or the reference
  filePath?: string;       // Path in container if offloaded
}

export class WorkspaceMemory {
  private containerId: string | null = null;
  private observationSeq = 0;

  /** Set the container to use for filesystem operations */
  setContainer(containerId: string): void {
    this.containerId = containerId;
  }

  /** Check if a container is available for workspace operations */
  hasContainer(): boolean {
    return this.containerId !== null;
  }

  /**
   * Provision the .alia workspace directory structure in a container.
   * Called when a container is first created for an agent session.
   */
  async provision(containerId: string): Promise<void> {
    this.containerId = containerId;

    try {
      await containerManager.execInContainer(
        containerId,
        'mkdir -p /workspace/.alia/observations /workspace/.alia/scripts',
        10,
      );

      // Initialize summary file
      await containerManager.writeFileToContainer(
        containerId,
        '/workspace/.alia/summary.md',
        '# Session Summary\n\nThis file is updated as the agent works.\n',
      );

      // Initialize todo file
      await containerManager.writeFileToContainer(
        containerId,
        '/workspace/.alia/todo.md',
        '# Task Plan\n\nNo plan yet.\n',
      );
    } catch (err) {
      log.agents.warn({ err, containerId }, 'Failed to provision workspace memory');
    }
  }

  /**
   * Check if content should be offloaded, and if so, save it to the filesystem.
   * Returns either the original content or a reference to the saved file.
   */
  async maybeOffload(content: string, seq: number): Promise<OffloadResult> {
    // If no container or content is small enough, return as-is
    if (!this.containerId || content.length < OFFLOAD_THRESHOLD_CHARS) {
      return { wasOffloaded: false, content };
    }

    const fileName = `${seq}.md`;
    const filePath = `/workspace/.alia/observations/${fileName}`;

    try {
      await containerManager.writeFileToContainer(this.containerId, filePath, content);
      this.observationSeq++;

      const sizeKB = Math.round(content.length / 1024);
      const reference = `[Full result saved to ${filePath} (${sizeKB}KB) — use file_read to retrieve]`;

      return { wasOffloaded: true, content: reference, filePath };
    } catch (err) {
      log.agents.warn({ err }, 'Failed to offload content to workspace');
      // Truncate as fallback if offload fails
      const truncated = content.slice(0, OFFLOAD_THRESHOLD_CHARS) + '\n\n[... truncated]';
      return { wasOffloaded: false, content: truncated };
    }
  }

  /**
   * Sync the todo list to the workspace filesystem.
   * This makes the plan visible as a file the agent can reference.
   */
  async syncTodo(todoMarkdown: string): Promise<void> {
    if (!this.containerId) return;

    try {
      await containerManager.writeFileToContainer(
        this.containerId,
        '/workspace/.alia/todo.md',
        `# Task Plan\n\n${todoMarkdown}\n`,
      );
    } catch (err) {
      log.agents.warn({ err }, 'Failed to sync todo to workspace');
    }
  }

  /**
   * Append to the running session summary.
   */
  async appendSummary(text: string): Promise<void> {
    if (!this.containerId) return;

    try {
      // Use exec to append (more reliable than read+write for concurrent access)
      const escaped = text.replace(/'/g, "'\\''");
      await containerManager.execInContainer(
        this.containerId,
        `echo '${escaped}' >> /workspace/.alia/summary.md`,
        10,
      );
    } catch (err) {
      log.agents.warn({ err }, 'Failed to append to session summary');
    }
  }
}
