/**
 * The canvas "memory" node, on Nilo's memories.
 *
 * A workflow reads and writes one value under a key. That value is a memory of the person in
 * Nilo: the key is its title, the value its detail. It goes through the same Oxy capability
 * tools Alia's chat uses (`oxy_nilo_memories__*`), with the person's own session, so a canvas
 * run has exactly the authority the person has and the memory shows up in Nilo where they can
 * edit it.
 */
import { randomUUID } from 'node:crypto';
import type { Tool, ToolSet } from 'ai';
import { buildOxyServiceTools } from '../tools/oxy-services.js';
import { ALIA_MEMORY_FAMILY } from '../tools/oxy-tool-names.js';

export interface CanvasMemoryAccess {
  readonly userId: string;
  /** The person's bearer. A canvas run without one cannot reach their memory. */
  readonly accessToken: string | undefined;
  readonly runId: string;
}

type MemoryTools = 'recallMemories' | 'remember' | 'updateMemory';

/** The title identity Nilo dedupes by: case, accents and spacing do not make a new memory. */
function foldMemoryKey(key: string): string {
  return key
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

interface RecalledMemory {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
}

async function toolsFor(access: CanvasMemoryAccess): Promise<ToolSet> {
  if (!access.accessToken) {
    throw new Error('Memory nodes need the signed-in session of the person running the workflow');
  }
  return buildOxyServiceTools(access.userId, {
    requesterAccountId: access.userId,
    ownerAccountId: access.userId,
    actor: { type: 'alia', ownerAccountId: access.userId },
    runId: access.runId,
    userAccessToken: access.accessToken,
  });
}

async function call(
  tools: ToolSet,
  name: MemoryTools,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tool = tools[`${ALIA_MEMORY_FAMILY}__${name}`] as Tool | undefined;
  if (!tool?.execute) throw new Error('Memory is unavailable right now');
  const result = (await tool.execute(args, {
    toolCallId: randomUUID(),
    messages: [],
  })) as Record<string, unknown> | undefined;
  if (!result || typeof result !== 'object') throw new Error('Memory is unavailable right now');
  if (typeof result.error === 'string') throw new Error(result.error);
  return result;
}

async function findByKey(tools: ToolSet, key: string): Promise<RecalledMemory | undefined> {
  const { memories } = await call(tools, 'recallMemories', { query: key, limit: 25 });
  const wanted = foldMemoryKey(key);
  return (Array.isArray(memories) ? (memories as RecalledMemory[]) : []).find(
    (memory) => foldMemoryKey(memory.title) === wanted,
  );
}

export async function readCanvasMemory(key: string, access: CanvasMemoryAccess): Promise<string> {
  const memory = await findByKey(await toolsFor(access), key);
  return memory?.detail ?? '';
}

export async function writeCanvasMemory(
  key: string,
  value: string,
  access: CanvasMemoryAccess,
): Promise<string> {
  const tools = await toolsFor(access);
  const existing = await findByKey(tools, key);
  if (existing) {
    await call(tools, 'updateMemory', { memoryId: existing.id, detail: value });
  } else {
    await call(tools, 'remember', {
      title: key,
      detail: value,
      kind: 'fact',
      source: 'alia-canvas',
    });
  }
  return value;
}
