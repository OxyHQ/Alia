/**
 * Restructure UserMemory.memories: key/value/category -> title/summary/type.
 * Old `key` becomes `title` verbatim (still human-readable enough; new writes
 * going forward use the AI-generated human-readable title convention).
 * `category` maps to the new `type` enum; unmapped/unknown categories default
 * to 'topic'. Every user document also gains `settings` with both flags on,
 * preserving today's always-on behavior.
 */
import mongoose from 'mongoose';

const CATEGORY_TO_TYPE: Record<string, 'profile' | 'topic' | 'person'> = {
  personal: 'profile',
  preferencia: 'topic',
  preference: 'topic',
  trabajo: 'topic',
  work: 'topic',
  objetivo: 'topic',
  goal: 'topic',
  experiencia: 'topic',
  experience: 'topic',
};

interface LegacyMemoryEntry {
  _id: mongoose.Types.ObjectId;
  key: string;
  value: string;
  category?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface LegacyUserMemoryDoc {
  _id: mongoose.Types.ObjectId;
  memories: LegacyMemoryEntry[];
}

export const description = 'Restructure UserMemory.memories (key/value/category -> title/summary/type) and add settings defaults';

export async function up(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB not connected');

  const collection = db.collection<LegacyUserMemoryDoc>('usermemories');
  const cursor = collection.find(
    { $or: [{ 'memories.key': { $exists: true } }, { settings: { $exists: false } }] },
    { batchSize: 200 }
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ops: any[] = [];
  let migrated = 0;

  for await (const doc of cursor) {
    const newMemories = (doc.memories || []).map((m) => ({
      _id: m._id,
      title: m.key,
      summary: m.value,
      type: CATEGORY_TO_TYPE[(m.category || '').toLowerCase()] || 'topic',
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }));

    ops.push({
      updateOne: {
        filter: { _id: doc._id },
        update: {
          $set: {
            memories: newMemories,
            settings: { autoSaveEnabled: true, recallEnabled: true },
          },
        },
      },
    });

    if (ops.length >= 200) {
      await collection.bulkWrite(ops as any);
      migrated += ops.length;
      ops = [];
    }
  }

  if (ops.length > 0) {
    await collection.bulkWrite(ops as any);
    migrated += ops.length;
  }

  console.log(`[migration 001] restructured ${migrated} UserMemory documents`);
}

// Best-effort reverse — type has no exact inverse of the old free-text
// category, so this is lossy (profile -> personal, everything else -> unset).
// Provided for local rollback only, not relied on in production.
export async function down(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB not connected');

  const collection = db.collection('usermemories');
  const cursor = collection.find({}, { batchSize: 200 });

  for await (const doc of cursor) {
    const oldMemories = ((doc as any).memories || []).map((m: any) => ({
      _id: m._id,
      key: m.title,
      value: m.summary,
      category: m.type === 'profile' ? 'personal' : undefined,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }));

    await collection.updateOne(
      { _id: doc._id },
      { $set: { memories: oldMemories }, $unset: { settings: '' } }
    );
  }
}
