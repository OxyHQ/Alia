/**
 * A space's shared notes on Postgres (ADR 0028): the same contract as an agent's own memory
 * (`db/agents/agentMemoryRepository.ts`) for a different owner, the space.
 *
 * Every write names the hash it read. Two writers (an agent and the person, or two agents of the same
 * space working at once) cannot silently overwrite each other: the second gets a conflict carrying what
 * the file holds now.
 */

import { and, asc, eq } from 'drizzle-orm';
import { hashAgentMemory } from '../../lib/agent/memory-contract';
import type { Executor } from '../index';
import { spaceMemoryDocuments } from '../schema/spaces';

export class SpaceNotesConflictError extends Error {
  constructor(
    readonly currentHash: string,
    readonly currentContent: string,
  ) {
    super('The notes changed since they were read');
    this.name = 'SpaceNotesConflictError';
  }
}

export type SpaceNotesDocument = typeof spaceMemoryDocuments.$inferSelect;

export async function listSpaceNotes(
  db: Executor,
  spaceId: string,
): Promise<
  Pick<SpaceNotesDocument, 'path' | 'byteLength' | 'version' | 'lastEditor' | 'updatedAt'>[]
> {
  return db
    .select({
      path: spaceMemoryDocuments.path,
      byteLength: spaceMemoryDocuments.byteLength,
      version: spaceMemoryDocuments.version,
      lastEditor: spaceMemoryDocuments.lastEditor,
      updatedAt: spaceMemoryDocuments.updatedAt,
    })
    .from(spaceMemoryDocuments)
    .where(eq(spaceMemoryDocuments.spaceId, spaceId))
    .orderBy(asc(spaceMemoryDocuments.path));
}

export async function readSpaceNotes(
  db: Executor,
  spaceId: string,
  path: string,
): Promise<SpaceNotesDocument | undefined> {
  const [row] = await db
    .select()
    .from(spaceMemoryDocuments)
    .where(and(eq(spaceMemoryDocuments.spaceId, spaceId), eq(spaceMemoryDocuments.path, path)))
    .limit(1);
  return row;
}

/**
 * Write one file. `expectedHash` is the hash of what the writer read (the hash of the empty string for a
 * file that does not exist yet). Throws {@link SpaceNotesConflictError} when it no longer matches.
 */
export async function writeSpaceNotes(
  db: Executor,
  input: {
    spaceId: string;
    path: string;
    content: string;
    expectedHash: string;
    /** `person`, or the id of the agent that wrote it. */
    editor: string;
  },
): Promise<SpaceNotesDocument> {
  return db.transaction(async (tx) => {
    const current = await readSpaceNotes(tx, input.spaceId, input.path);
    const emptyHash = hashAgentMemory('');
    const currentHash = current?.contentHash ?? emptyHash;
    if (currentHash !== input.expectedHash) {
      throw new SpaceNotesConflictError(currentHash, current?.content ?? '');
    }
    const values = {
      spaceId: input.spaceId,
      path: input.path,
      content: input.content,
      contentHash: hashAgentMemory(input.content),
      byteLength: Buffer.byteLength(input.content, 'utf8'),
      version: (current?.version ?? 0) + 1,
      lastEditor: input.editor,
      updatedAt: new Date(),
    };
    const [document] = current
      ? await tx
          .update(spaceMemoryDocuments)
          .set(values)
          .where(
            and(
              eq(spaceMemoryDocuments.id, current.id),
              eq(spaceMemoryDocuments.contentHash, input.expectedHash),
            ),
          )
          .returning()
      : await tx.insert(spaceMemoryDocuments).values(values).onConflictDoNothing().returning();
    if (!document) {
      // Lost a race between the read and the write: report what is there now.
      const latest = await readSpaceNotes(tx, input.spaceId, input.path);
      throw new SpaceNotesConflictError(latest?.contentHash ?? emptyHash, latest?.content ?? '');
    }
    return document;
  });
}

/** Delete one file; returns how many rows went. */
export async function deleteSpaceNotes(
  db: Executor,
  spaceId: string,
  path: string,
): Promise<number> {
  const rows = await db
    .delete(spaceMemoryDocuments)
    .where(and(eq(spaceMemoryDocuments.spaceId, spaceId), eq(spaceMemoryDocuments.path, path)))
    .returning({ id: spaceMemoryDocuments.id });
  return rows.length;
}
