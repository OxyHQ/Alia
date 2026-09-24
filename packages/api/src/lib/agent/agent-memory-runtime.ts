/**
 * The agent's own memory of one person, used while it works.
 *
 * `agent_memory_documents` held a MEMORY.md (and topic files) per agent and
 * person, editable by the person through `routes/agents/memory.ts` — and read
 * by nothing at runtime. So an agent never remembered anything about you from
 * one conversation to the next except what landed in the person's GLOBAL
 * memory, which every agent shares. This is the agent's side of that store:
 * the index goes into its prompt, and a `memory` tool lets it keep it current.
 *
 * Writes go through `writeAgentMemory` with the hash it just read, so an
 * agent and the person editing the same file cannot silently overwrite each
 * other, and every write is journaled with origin `agent`.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import {
  AgentMemoryConflictError,
  listAgentMemory,
  readAgentMemory,
  writeAgentMemory,
} from '../../db/agents/agentMemoryRepository.js';
import {
  AGENT_MEMORY_FILE_MAX_BYTES,
  AGENT_MEMORY_INDEX,
  agentMemoryPromptSlice,
  hashAgentMemory,
  parseAgentMemoryPath,
} from './memory-contract.js';
import { getErrorMessage } from '../errors/index.js';

/** The prompt section carrying this agent's MEMORY.md for this person, or ''. */
export async function agentMemoryPromptSection(oxyUserId: string, agentId: string): Promise<string> {
  const index = await readAgentMemory(getDb(), oxyUserId, agentId, AGENT_MEMORY_INDEX).catch(() => undefined);
  const content = index?.content.trim();
  if (!content) {
    return '\n\n## Your memory of this person\nYour MEMORY.md for this person is empty. When you learn something worth remembering across conversations (who they are, what they want from you, decisions, preferences), save it with the `memory` tool.';
  }
  const slice = agentMemoryPromptSlice(content);
  return `\n\n## Your memory of this person (MEMORY.md)\n${slice.content}${slice.truncated ? '\n[…truncated; read the rest with the memory tool]' : ''}\n\nKeep it current with the \`memory\` tool: short, factual lines; topic detail in memory/<topic>.md.`;
}

/** The `memory` tool: read, list and write this agent's files about this person. */
export function buildAgentMemoryTool(input: { oxyUserId: string; agentId: string; actorOxyAccountId: string }) {
  const { oxyUserId, agentId, actorOxyAccountId } = input;
  return tool({
    description: 'Your own long-term memory about this person, kept across conversations: MEMORY.md (the index you always see) and memory/<topic>.md files. Actions: list; read a file; append a line; replace a file\'s whole content. Save only what will still matter later.',
    inputSchema: z.object({
      action: z.enum(['list', 'read', 'append', 'replace']),
      path: z.string().optional().describe('MEMORY.md (default) or memory/<topic>.md'),
      content: z.string().optional().describe('The line to append, or the new whole content for replace'),
    }),
    execute: async ({ action, path, content }) => {
      try {
        if (action === 'list') {
          const files = await listAgentMemory(getDb(), oxyUserId, agentId);
          return files.length === 0 ? 'No memory files yet.' : files.map((f) => `${f.path} (${f.byteLength} bytes)`).join('\n');
        }
        const target = parseAgentMemoryPath(path ?? AGENT_MEMORY_INDEX).path;
        const current = await readAgentMemory(getDb(), oxyUserId, agentId, target);
        if (action === 'read') return current?.content || `${target} is empty.`;
        if (!content?.trim()) return 'Error: content is required';
        const before = current?.content ?? '';
        const next = action === 'append'
          ? `${before.replace(/\s+$/, '')}${before.trim() ? '\n' : ''}${content.trim()}\n`
          : content;
        if (Buffer.byteLength(next, 'utf8') > AGENT_MEMORY_FILE_MAX_BYTES) {
          return 'Error: the file would be too large. Condense it with replace, or move detail to a memory/<topic>.md file.';
        }
        await writeAgentMemory(getDb(), {
          oxyUserId,
          agentId,
          actorOxyAccountId,
          path: target,
          content: next,
          expectedHash: current?.contentHash ?? hashAgentMemory(''),
          origin: 'agent',
        });
        return `Saved ${target}.`;
      } catch (err: unknown) {
        if (err instanceof AgentMemoryConflictError) return 'Error: the file changed while you were writing (the person may have edited it). Read it again, then retry.';
        return `Error: ${getErrorMessage(err)}`;
      }
    },
  });
}
