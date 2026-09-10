/*
 * Path and capacity rules adapted from OpenMausBot server/memory-store.ts at
 * 0a17fa5759e7b77ce4c3a0326109ca342da9c260. Apache-2.0.
 * Modified for database-backed Alia memory.
 */
import { createHash } from 'node:crypto';

export const AGENT_MEMORY_INDEX = 'MEMORY.md';
export const AGENT_MEMORY_MAX_LINES = 200;
export const AGENT_MEMORY_MAX_BYTES = 24 * 1024;
export const AGENT_MEMORY_FILE_MAX_BYTES = 256 * 1024;
const FILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,126}\.md$/;

export type AgentMemoryKind = 'index' | 'topic' | 'log';

export function parseAgentMemoryPath(path: string): { path: string; name: string; kind: AgentMemoryKind } {
  if (path === AGENT_MEMORY_INDEX) return { path, name: path, kind: 'index' };
  const parts = path.split('/');
  if (parts.length === 2 && parts[0] === 'memory' && FILE_NAME.test(parts[1]!)) {
    return { path, name: parts[1]!, kind: 'topic' };
  }
  if (parts.length === 3 && parts[0] === 'memory' && parts[1] === 'log' && FILE_NAME.test(parts[2]!)) {
    return { path, name: parts[2]!, kind: 'log' };
  }
  throw new Error('Use MEMORY.md, memory/<topic>.md, or memory/log/<day>.md');
}

export function hashAgentMemory(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function agentMemoryPromptSlice(content: string): { content: string; truncated: boolean } {
  let sliced = content.split('\n').slice(0, AGENT_MEMORY_MAX_LINES).join('\n');
  let truncated = sliced !== content;
  if (Buffer.byteLength(sliced, 'utf8') > AGENT_MEMORY_MAX_BYTES) {
    sliced = Buffer.from(sliced, 'utf8').subarray(0, AGENT_MEMORY_MAX_BYTES).toString('utf8').replace(/�+$/, '');
    truncated = true;
  }
  return { content: sliced, truncated };
}
