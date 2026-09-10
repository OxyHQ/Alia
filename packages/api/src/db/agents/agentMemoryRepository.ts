import { and, desc, eq } from 'drizzle-orm';
import type { ApiDatabase, Executor } from '../index.js';
import { agentMemoryDocuments, agentMemoryJournal } from '../schema/agent-runtime.js';
import { hashAgentMemory } from '../../lib/agent/memory-contract.js';

export class AgentMemoryConflictError extends Error {
  constructor(readonly currentHash: string, readonly currentContent: string) {
    super('Agent memory changed since it was read');
  }
}

export async function listAgentMemory(db: ApiDatabase, oxyUserId: string, agentId: string) {
  return db.select({
    path: agentMemoryDocuments.path,
    contentHash: agentMemoryDocuments.contentHash,
    byteLength: agentMemoryDocuments.byteLength,
    version: agentMemoryDocuments.version,
    updatedAt: agentMemoryDocuments.updatedAt,
  }).from(agentMemoryDocuments).where(and(
    eq(agentMemoryDocuments.oxyUserId, oxyUserId),
    eq(agentMemoryDocuments.agentId, agentId),
  )).orderBy(desc(agentMemoryDocuments.updatedAt));
}

export async function readAgentMemory(db: Executor, oxyUserId: string, agentId: string, path: string) {
  const [row] = await db.select().from(agentMemoryDocuments).where(and(
    eq(agentMemoryDocuments.oxyUserId, oxyUserId),
    eq(agentMemoryDocuments.agentId, agentId),
    eq(agentMemoryDocuments.path, path),
  )).limit(1);
  return row;
}

export async function writeAgentMemory(db: ApiDatabase, input: {
  oxyUserId: string;
  agentId: string;
  actorOxyAccountId: string;
  path: string;
  content: string;
  expectedHash: string;
  origin: 'person' | 'agent' | 'import' | 'rollback';
}) {
  return db.transaction(async (tx) => {
    const current = await readAgentMemory(tx, input.oxyUserId, input.agentId, input.path);
    const emptyHash = hashAgentMemory('');
    const currentHash = current?.contentHash ?? emptyHash;
    if (currentHash !== input.expectedHash) {
      throw new AgentMemoryConflictError(currentHash, current?.content ?? '');
    }
    const contentHash = hashAgentMemory(input.content);
    const values = {
      oxyUserId: input.oxyUserId,
      agentId: input.agentId,
      path: input.path,
      content: input.content,
      contentHash,
      byteLength: Buffer.byteLength(input.content, 'utf8'),
      version: (current?.version ?? 0) + 1,
      updatedAt: new Date(),
    };
    const [document] = current
      ? await tx.update(agentMemoryDocuments).set(values).where(and(
          eq(agentMemoryDocuments.id, current.id),
          eq(agentMemoryDocuments.contentHash, input.expectedHash),
        )).returning()
      : await tx.insert(agentMemoryDocuments).values(values).onConflictDoNothing().returning();
    if (!document) {
      const latest = await readAgentMemory(tx, input.oxyUserId, input.agentId, input.path);
      throw new AgentMemoryConflictError(latest?.contentHash ?? emptyHash, latest?.content ?? '');
    }
    await tx.insert(agentMemoryJournal).values({
      documentId: document.id,
      agentId: input.agentId,
      oxyUserId: input.oxyUserId,
      actorOxyAccountId: input.actorOxyAccountId,
      origin: input.origin,
      beforeHash: current?.contentHash ?? null,
      afterHash: contentHash,
      beforeContent: current?.content ?? null,
      afterContent: input.content,
    });
    return document;
  });
}
