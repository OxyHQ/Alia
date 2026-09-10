import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Clearing a conversation, and clearing it FOR GOOD.
 *
 * This file exists because of #553: the header's "Clear conversation" asked
 * for confirmation under "This action cannot be undone", then reset the local
 * message list and nothing else — and the cached history hydrated straight
 * back on the next render. The persistent half now lives in
 * `DELETE /conversations/:id/messages`, and what is pinned here is the shape
 * that makes it a clear rather than a delete or a leak:
 *
 * - the messages go and the PREVIEW goes with them, in that transaction, so a
 *   half-done clear is not a thread advertising a turn it no longer holds;
 * - the conversation ROW is never touched beyond its preview — no
 *   `deleteConversation` reaches the repository — because clearing is
 *   emptying a thread, not removing it;
 * - a thread the caller does not own answers 404 and reaches NO delete, and
 *   answers the same 404 as one that is not there at all.
 *
 * The database is mocked at the repository boundary; `conversation-lifecycle
 * .pgdb.test.ts` is where the real ownership scoping of these statements is
 * proven against Postgres. What this file adds is the ROUTE'S composition of
 * them — which one decides, which one is skipped, and what the caller hears.
 */

const USER_ID = 'clearer';
const CONVERSATION_ID = 'thread-under-test';

/** Every repository call, in the order the route made it. */
let sequence: string[] = [];
/** How many rows the preview reset matched: `0` models "not yours / not there". */
let matched = 1;
/** Set to throw from the message delete, to model a clear that fails halfway. */
let deleteFailure: Error | null = null;

/** The one transaction handle the mocked `getDb().transaction` hands out. */
const TX = { kind: 'tx' } as const;

vi.mock('../../middleware/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../middleware/auth.js')>(
    '../../middleware/auth.js',
  );
  return {
    ...actual,
    authenticateToken: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { id: USER_ID };
      next();
    },
  };
});

vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child, chat: child, general: child, v1: child, providers: child, codea: child } };
});

vi.mock('../../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js');
  return {
    ...actual,
    getDb: () => ({
      transaction: async <T>(run: (tx: typeof TX) => Promise<T>) => {
        sequence.push('tx:begin');
        try {
          const out = await run(TX);
          sequence.push('tx:commit');
          return out;
        } catch (error) {
          sequence.push('tx:rollback');
          throw error;
        }
      },
    }),
  };
});

vi.mock('../../db/chat/conversationRepository.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/chat/conversationRepository.js')>(
    '../../db/chat/conversationRepository.js',
  );
  return {
    ...actual,
    clearConversationPreview: async (db: unknown, oxyUserId: string, conversationId: string) => {
      sequence.push(`clearPreview:${db === TX ? 'tx' : 'root'}:${oxyUserId}:${conversationId}`);
      return matched;
    },
    deleteConversation: async (_db: unknown, oxyUserId: string, conversationId: string) => {
      sequence.push(`deleteConversation:${oxyUserId}:${conversationId}`);
      return 1;
    },
  };
});

vi.mock('../../db/chat/messageRepository.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/chat/messageRepository.js')>(
    '../../db/chat/messageRepository.js',
  );
  return {
    ...actual,
    deleteMessages: async (db: unknown, oxyUserId: string, conversationId: string) => {
      sequence.push(`deleteMessages:${db === TX ? 'tx' : 'root'}:${oxyUserId}:${conversationId}`);
      if (deleteFailure) throw deleteFailure;
      return 3;
    },
  };
});

import conversationsRouter from '../conversations.js';

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/conversations', conversationsRouter);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(
  async () =>
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
);

beforeEach(() => {
  sequence = [];
  matched = 1;
  deleteFailure = null;
});

const clear = (id: string) => fetch(`${base}/conversations/${id}/messages`, { method: 'DELETE' });

describe('DELETE /conversations/:id/messages', () => {
  it('drops the preview and the messages, as the caller, in one transaction', async () => {
    const response = await clear(CONVERSATION_ID);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    // Both statements ran on the transaction handle, scoped to THIS user, and
    // the ownership answer came first: the delete is conditional on it.
    expect(sequence).toEqual([
      'tx:begin',
      `clearPreview:tx:${USER_ID}:${CONVERSATION_ID}`,
      `deleteMessages:tx:${USER_ID}:${CONVERSATION_ID}`,
      'tx:commit',
    ]);
  });

  it('never deletes the conversation row itself', async () => {
    await clear(CONVERSATION_ID);

    // A clear that reached `deleteConversation` would be the sidebar item
    // vanishing under a dialog that promised to empty it.
    expect(sequence.some((step) => step.startsWith('deleteConversation'))).toBe(false);
  });

  it('answers 404 and deletes nothing for a thread the caller does not own', async () => {
    matched = 0;

    const response = await clear(CONVERSATION_ID);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Conversation not found' });
    // The guard is the preview reset matching zero rows; no delete follows it.
    expect(sequence).toEqual([
      'tx:begin',
      `clearPreview:tx:${USER_ID}:${CONVERSATION_ID}`,
      'tx:commit',
    ]);
  });

  it('answers the same 404 for a thread that does not exist at all', async () => {
    matched = 0;

    const response = await clear('never-existed');

    // One body for "not yours" and "not there", so an id cannot be probed for.
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Conversation not found' });
    expect(sequence.some((step) => step.startsWith('deleteMessages'))).toBe(false);
  });

  it('rolls the preview reset back when the message delete fails, and says so', async () => {
    deleteFailure = new Error('connection reset');

    const response = await clear(CONVERSATION_ID);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to clear conversation' });
    // The failure propagated out of the transaction rather than being swallowed
    // into a 200 — which is what would leave a thread emptied on one side only.
    expect(sequence).toEqual([
      'tx:begin',
      `clearPreview:tx:${USER_ID}:${CONVERSATION_ID}`,
      `deleteMessages:tx:${USER_ID}:${CONVERSATION_ID}`,
      'tx:rollback',
    ]);
  });

  it('does not shadow DELETE /conversations/:id, which still removes the row', async () => {
    const response = await fetch(`${base}/conversations/${CONVERSATION_ID}`, { method: 'DELETE' });

    expect(response.status).toBe(200);
    // The whole-thread delete is a different route with a different shape: the
    // row goes, and it runs on the root handle exactly as before.
    expect(sequence).toEqual([
      `deleteConversation:${USER_ID}:${CONVERSATION_ID}`,
      `deleteMessages:root:${USER_ID}:${CONVERSATION_ID}`,
    ]);
  });
});
