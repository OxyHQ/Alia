import { uuidv7 } from '@oxy.so/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashAgentMemory } from '../../lib/agent/memory-contract';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  SpaceNotesConflictError,
  deleteSpaceNotes,
  listSpaceNotes,
  readSpaceNotes,
  writeSpaceNotes,
} from '../spaces/spaceMemoryRepository';
import { createSpace, deleteSpace } from '../spaces/spaceRepository';

/**
 * A space's shared notes against a REAL server (ADR 0028): the hash contract that keeps two writers from
 * silently overwriting each other, including under a real race, and that the notes go with the space.
 */

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => closePostgres());

const EMPTY = hashAgentMemory('');

async function newSpace() {
  const owner = `sn-person-${uuidv7()}`;
  return { owner, space: await createSpace(db, { oxyUserId: owner, name: 'S', instructions: '' }) };
}

describe('a space’s notes', () => {
  it('start empty, and a first write names the hash of nothing', async () => {
    const { space } = await newSpace();
    expect(await readSpaceNotes(db, space.id, 'MEMORY.md')).toBeUndefined();

    const written = await writeSpaceNotes(db, {
      spaceId: space.id,
      path: 'MEMORY.md',
      content: '- launch Friday\n',
      expectedHash: EMPTY,
      editor: 'agent-1',
    });

    expect(written).toMatchObject({ version: 1, lastEditor: 'agent-1', byteLength: 16 });
    expect(written.contentHash).toBe(hashAgentMemory('- launch Friday\n'));
  });

  it('refuse a write that did not read the latest version, and say what is there now', async () => {
    const { space } = await newSpace();
    const first = await writeSpaceNotes(db, {
      spaceId: space.id,
      path: 'MEMORY.md',
      content: 'one',
      expectedHash: EMPTY,
      editor: 'agent-1',
    });
    await writeSpaceNotes(db, {
      spaceId: space.id,
      path: 'MEMORY.md',
      content: 'two',
      expectedHash: first.contentHash,
      editor: 'person',
    });

    const stale = writeSpaceNotes(db, {
      spaceId: space.id,
      path: 'MEMORY.md',
      content: 'three',
      expectedHash: first.contentHash,
      editor: 'agent-2',
    });

    await expect(stale).rejects.toBeInstanceOf(SpaceNotesConflictError);
    await expect(stale).rejects.toMatchObject({ currentContent: 'two' });
    expect((await readSpaceNotes(db, space.id, 'MEMORY.md'))?.content).toBe('two');
  });

  it('let exactly one of several simultaneous writers through', async () => {
    const { space } = await newSpace();
    const base = await writeSpaceNotes(db, {
      spaceId: space.id,
      path: 'MEMORY.md',
      content: 'base',
      expectedHash: EMPTY,
      editor: 'agent-0',
    });

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        writeSpaceNotes(db, {
          spaceId: space.id,
          path: 'MEMORY.md',
          content: `writer ${i}`,
          expectedHash: base.contentHash,
          editor: `agent-${i}`,
        }),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      results.filter((r) => r.status === 'rejected' && r.reason instanceof SpaceNotesConflictError),
    ).toHaveLength(5);
  });

  it('list their files, and delete one without touching the others', async () => {
    const { space } = await newSpace();
    for (const path of ['MEMORY.md', 'memory/launch.md']) {
      await writeSpaceNotes(db, {
        spaceId: space.id,
        path,
        content: path,
        expectedHash: EMPTY,
        editor: 'agent-1',
      });
    }

    // Sorted here: the database's own order follows its collation, which is not this test's subject.
    const listed = async () => (await listSpaceNotes(db, space.id)).map((f) => f.path).sort();
    expect(await listed()).toEqual(['MEMORY.md', 'memory/launch.md']);
    expect(await deleteSpaceNotes(db, space.id, 'memory/launch.md')).toBe(1);
    expect(await deleteSpaceNotes(db, space.id, 'memory/launch.md')).toBe(0);
    expect(await listed()).toEqual(['MEMORY.md']);
  });

  it('are not shared between spaces', async () => {
    const a = await newSpace();
    const b = await newSpace();
    await writeSpaceNotes(db, {
      spaceId: a.space.id,
      path: 'MEMORY.md',
      content: 'secret of A',
      expectedHash: EMPTY,
      editor: 'agent-1',
    });

    expect(await readSpaceNotes(db, b.space.id, 'MEMORY.md')).toBeUndefined();
    expect(await listSpaceNotes(db, b.space.id)).toEqual([]);
  });

  it('go with the space when it is deleted', async () => {
    const { owner, space } = await newSpace();
    await writeSpaceNotes(db, {
      spaceId: space.id,
      path: 'MEMORY.md',
      content: 'x',
      expectedHash: EMPTY,
      editor: 'agent-1',
    });

    expect(await deleteSpace(db, owner, space.id)).toBe(true);

    expect(await listSpaceNotes(db, space.id)).toEqual([]);
  });
});
