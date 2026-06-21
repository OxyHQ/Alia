/**
 * Terminal AI SDK tools — exposed to generateText() for command execution.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { runCommand, destroySession } from './manager';
import * as fs from 'fs/promises';
import * as path from 'path';

const WORK_DIR = '/tmp/alia-workspace';

/**
 * Get terminal tools for a specific session.
 */
export function getTerminalTools(sessionId: string) {
  return {
    run_command: tool({
      description: 'Execute a shell command in a sandboxed terminal. Returns the command output (stdout + stderr). Use for installing packages, running scripts, data processing, etc.',
      inputSchema: z.object({
        command: z.string().describe('The shell command to execute'),
      }),
      execute: async ({ command }) => {
        await fs.mkdir(WORK_DIR, { recursive: true }).catch(() => {});
        const output = await runCommand(sessionId, `cd ${WORK_DIR} && ${command}`);
        return { output: output.slice(0, 10000), command };
      },
    }),

    read_file: tool({
      description: 'Read the contents of a file in the workspace.',
      inputSchema: z.object({
        filepath: z.string().describe('Path to the file (relative to workspace or absolute under /tmp)'),
      }),
      execute: async ({ filepath }) => {
        const resolved = filepath.startsWith('/') ? filepath : path.join(WORK_DIR, filepath);
        if (!resolved.startsWith('/tmp')) {
          return { error: 'Can only read files under /tmp' };
        }
        try {
          const content = await fs.readFile(resolved, 'utf-8');
          return { content: content.slice(0, 20000), path: resolved };
        } catch (err: any) {
          return { error: err.message };
        }
      },
    }),

    write_file: tool({
      description: 'Write content to a file in the workspace.',
      inputSchema: z.object({
        filepath: z.string().describe('Path to the file (relative to workspace or absolute under /tmp)'),
        content: z.string().describe('Content to write'),
      }),
      execute: async ({ filepath, content }) => {
        const resolved = filepath.startsWith('/') ? filepath : path.join(WORK_DIR, filepath);
        if (!resolved.startsWith('/tmp')) {
          return { error: 'Can only write files under /tmp' };
        }
        try {
          await fs.mkdir(path.dirname(resolved), { recursive: true });
          await fs.writeFile(resolved, content, 'utf-8');
          return { written: resolved, bytes: content.length };
        } catch (err: any) {
          return { error: err.message };
        }
      },
    }),

    list_files: tool({
      description: 'List files and directories in the workspace.',
      inputSchema: z.object({
        dir: z.string().optional().describe('Directory to list (defaults to workspace root)'),
      }),
      execute: async ({ dir }) => {
        const resolved = dir
          ? dir.startsWith('/') ? dir : path.join(WORK_DIR, dir)
          : WORK_DIR;
        if (!resolved.startsWith('/tmp')) {
          return { error: 'Can only list under /tmp' };
        }
        try {
          const entries = await fs.readdir(resolved, { withFileTypes: true });
          return {
            files: entries.map((e) => ({
              name: e.name,
              type: e.isDirectory() ? 'directory' : 'file',
            })),
          };
        } catch (err: any) {
          return { error: err.message };
        }
      },
    }),

    close_terminal: tool({
      description: 'Close the terminal session.',
      inputSchema: z.object({}),
      execute: async () => {
        destroySession(sessionId);
        return { closed: true };
      },
    }),
  };
}
