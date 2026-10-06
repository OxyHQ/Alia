import { and, desc, eq, inArray, max, sql } from 'drizzle-orm';
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

/** Every agent that remembers something about this person, most recently written first. */
export async function listAgentsRememberingPerson(db: Executor, oxyUserId: string) {
  return db.select({
    agentId: agentMemoryDocuments.agentId,
    files: sql<number>`count(*)::int`,
    updatedAt: max(agentMemoryDocuments.updatedAt),
  }).from(agentMemoryDocuments)
    .where(eq(agentMemoryDocuments.oxyUserId, oxyUserId))
    .groupBy(agentMemoryDocuments.agentId)
    .orderBy(desc(max(agentMemoryDocuments.updatedAt)));
}

/**
 * Forget: delete one memory file of this agent about this person, or all of
 * them when `path` is omitted — and the journal of those files with them.
 *
 * The journal keeps every write's before and after content, which is what
 * makes concurrent edits safe and a bad write reversible. Forgetting that kept
 * the old text there would be a deletion in the UI and a copy in the database,
 * so a forgotten file's history goes too. Returns how many files went.
 */
export async function deleteAgentMemory(db: ApiDatabase, input: {
  oxyUserId: string;
  agentId: string;
  path?: string;
}): Promise<number> {
  return db.transaction(async (tx) => {
    const removed = await tx.delete(agentMemoryDocuments).where(and(
      eq(agentMemoryDocuments.oxyUserId, input.oxyUserId),
      eq(agentMemoryDocuments.agentId, input.agentId),
      ...(input.path === undefined ? [] : [eq(agentMemoryDocuments.path, input.path)]),
    )).returning({ id: agentMemoryDocuments.id });
    if (removed.length > 0) {
      await tx.delete(agentMemoryJournal).where(and(
        eq(agentMemoryJournal.oxyUserId, input.oxyUserId),
        eq(agentMemoryJournal.agentId, input.agentId),
        inArray(agentMemoryJournal.documentId, removed.map((row) => row.id)),
      ));
    }
    return removed.length;
  });
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
