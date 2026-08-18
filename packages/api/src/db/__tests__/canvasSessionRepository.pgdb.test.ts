import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  canvasSessionExists,
  deleteCanvasSession,
  findCanvasComponents,
} from '../chat/canvasSessionRepository';
import { canvasSessions } from '../schema/chat';
import type { CanvasComponent } from '../../domain/canvas-session.js';

/**
 * The canvas repository against a real server.
 *
 * The table has NO WRITER in the package — `lib/tools/canvas.ts` mints a
 * component and hands it to the model, and nothing stores it — so every fixture
 * here inserts directly. That is deliberate: writing an `upsertCanvasSession`
 * for the tests to use would be an unused production write with no reviewer,
 * and the tests would then be the only thing exercising it.
 */

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

const OWNER = 'canv-owner';
const STRANGER = 'canv-stranger';

const COMPONENT: CanvasComponent = {
  id: 'cmp-1',
  type: 'chart',
  title: 'Revenue',
  data: { chartType: 'bar', labels: ['a'], datasets: [{ data: [1] }] },
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('reading a canvas', () => {
  it('returns the components for its owner and nothing for anyone else', async () => {
    await db.insert(canvasSessions).values({
      oxyUserId: OWNER,
      conversationId: 'canv-read',
      components: [COMPONENT],
    });

    expect(await findCanvasComponents(db, OWNER, 'canv-read')).toEqual([COMPONENT]);
    // Another account asking for the same conversation gets the missing answer,
    // not the components — the owner is in the WHERE, not checked afterwards.
    expect(await findCanvasComponents(db, STRANGER, 'canv-read')).toBeUndefined();
    expect(await canvasSessionExists(db, OWNER, 'canv-read')).toBe(true);
    expect(await canvasSessionExists(db, STRANGER, 'canv-read')).toBe(false);
  });

  it('tells an EMPTY canvas apart from no canvas at all', async () => {
    /**
     * `undefined` and `[]` are different facts and the repository keeps them
     * apart even though `routes/canvas/sessions.ts` collapses both to
     * `{ components: [] }`. Collapsing here would make the distinction
     * unrecoverable for any later caller.
     */
    await db.insert(canvasSessions).values({
      oxyUserId: OWNER,
      conversationId: 'canv-empty',
      components: [],
    });

    expect(await findCanvasComponents(db, OWNER, 'canv-empty')).toEqual([]);
    expect(await findCanvasComponents(db, OWNER, 'canv-absent')).toBeUndefined();
    expect(await canvasSessionExists(db, OWNER, 'canv-empty')).toBe(true);
    expect(await canvasSessionExists(db, OWNER, 'canv-absent')).toBe(false);
  });

  it('round-trips a component\'s open `data` without reshaping it', async () => {
    // `data` is per-type and shaped by whichever tool call produced it, so the
    // column is `jsonb` and the only correct behaviour is verbatim.
    const table: CanvasComponent = {
      id: 'cmp-2',
      type: 'table',
      title: 'Rows',
      data: { headers: ['a', 'b'], rows: [[1, null], ['x', true]] },
      createdAt: '2026-02-02T12:00:00.000Z',
    };
    await db.insert(canvasSessions).values({
      oxyUserId: OWNER,
      conversationId: 'canv-shape',
      components: [COMPONENT, table],
    });

    expect(await findCanvasComponents(db, OWNER, 'canv-shape')).toEqual([COMPONENT, table]);
  });
});

describe('clearing a canvas', () => {
  it('removes only its owner\'s row, reporting rows removed off count', async () => {
    await db.insert(canvasSessions).values({
      oxyUserId: OWNER,
      conversationId: 'canv-delete',
      components: [COMPONENT],
    });
    await db.insert(canvasSessions).values({
      oxyUserId: STRANGER,
      conversationId: 'canv-delete',
      components: [COMPONENT],
    });

    expect(await deleteCanvasSession(db, OWNER, 'canv-delete')).toBe(1);
    expect(await findCanvasComponents(db, OWNER, 'canv-delete')).toBeUndefined();
    // The other account's canvas for the SAME conversation id survives, which is
    // the whole reason the unique index is on the PAIR.
    expect(await findCanvasComponents(db, STRANGER, 'canv-delete')).toEqual([COMPONENT]);

    // A repeat removes nothing. The route answers 200 either way, exactly as
    // `findOneAndDelete` did when it matched nothing.
    expect(await deleteCanvasSession(db, OWNER, 'canv-delete')).toBe(0);
  });
});
