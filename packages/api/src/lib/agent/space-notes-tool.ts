/**
 * The notes of a SPACE, as the agents in it use them (ADR 0028).
 *
 * A member keeps the space's shared memory with this tool: what was decided, what is done, what is next,
 * for the others to read. It is the space's counterpart of the per-agent `memory` tool and follows its
 * contract (a `MEMORY.md` index, `memory/<topic>.md` files, a write names the hash it read). The index
 * also goes into every member's prompt (`agentSpacePrompt`), as labelled data.
 */

import { tool } from 'ai';
import { z } from 'zod';
import {
  SpaceNotesConflictError,
  deleteSpaceNotes,
  listSpaceNotes,
  readSpaceNotes,
  writeSpaceNotes,
} from '../../db/spaces/spaceMemoryRepository.js';
import { getDb } from '../../db/index.js';
import { getErrorMessage } from '../errors/index.js';
import {
  AGENT_MEMORY_FILE_MAX_BYTES,
  AGENT_MEMORY_INDEX,
  hashAgentMemory,
  parseAgentMemoryPath,
} from './memory-contract.js';

export const SPACE_NOTES_TOOL = 'spaceNotes';

export function buildSpaceNotesTool(input: { spaceId: string; agentId: string }) {
  const { spaceId, agentId } = input;
  return tool({
    description:
      "The shared notes of the space you work in, read by every agent in it and by the person: MEMORY.md (the index everyone always sees) and notes/topic files under memory/<topic>.md. Use it so the others know what is decided, what is done and what is next. Actions: list; read a file; append a line; replace a file's whole content; forget (delete) a file. Keep it short and factual.",
    inputSchema: z.object({
      action: z.enum(['list', 'read', 'append', 'replace', 'forget']),
      path: z.string().optional().describe('MEMORY.md (default) or memory/<topic>.md'),
      content: z
        .string()
        .optional()
        .describe('The line to append, or the new whole content for replace'),
    }),
    execute: async ({ action, path, content }) => {
      try {
        if (action === 'list') {
          const files = await listSpaceNotes(getDb(), spaceId);
          return files.length === 0
            ? 'No notes yet.'
            : files.map((f) => `${f.path} (${f.byteLength} bytes)`).join('\n');
        }
        const target = parseAgentMemoryPath(path ?? AGENT_MEMORY_INDEX).path;
        if (action === 'forget') {
          const removed = await deleteSpaceNotes(getDb(), spaceId, target);
          return removed === 0 ? `${target} did not exist.` : `Removed ${target}.`;
        }
        const current = await readSpaceNotes(getDb(), spaceId, target);
        if (action === 'read') return current?.content || `${target} is empty.`;
        if (!content?.trim()) return 'Error: content is required';
        const before = current?.content ?? '';
        const next =
          action === 'append'
            ? `${before.replace(/\s+$/, '')}${before.trim() ? '\n' : ''}${content.trim()}\n`
            : content;
        if (Buffer.byteLength(next, 'utf8') > AGENT_MEMORY_FILE_MAX_BYTES) {
          return 'Error: the file would be too large. Condense it with replace, or move detail to a memory/<topic>.md file.';
        }
        await writeSpaceNotes(getDb(), {
          spaceId,
          path: target,
          content: next,
          expectedHash: current?.contentHash ?? hashAgentMemory(''),
          editor: agentId,
        });
        return `Saved ${target}.`;
      } catch (err: unknown) {
        if (err instanceof SpaceNotesConflictError)
          return 'Error: the notes changed while you were writing (another agent or the person edited them). Read the file again, then retry.';
        return `Error: ${getErrorMessage(err)}`;
      }
    },
  });
}
