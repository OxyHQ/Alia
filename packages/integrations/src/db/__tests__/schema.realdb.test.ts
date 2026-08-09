/**
 * The properties a MOCKED repository cannot see.
 *
 * Every assertion here is enforced by Postgres, not by application code: a CHECK
 * constraint, a unique index, an `ON DELETE CASCADE`, an `ON CONFLICT` upsert.
 * A mocked `insert` accepts any statement, including one the server rejects
 * outright — which is exactly the class of defect a Mongo→Postgres port
 * introduces, so these run against a real server on purpose.
 *
 * The database is the throwaway one `vitest.pg.globalSetup.ts` created and
 * migrated through the REAL `src/db/migrate.ts` entrypoint.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  constraintNameOf,
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
} from '@oxyhq/db';
import { closePostgres, connectPostgres, type IntegrationsDatabase } from '../index';
import {
  mcpConnectorAuths,
  telegramSessions,
  whatsappChats,
  whatsappMessages,
  whatsappSessions,
} from '../schema';

let db: IntegrationsDatabase;

/**
 * Run `operation` and return the error it threw.
 *
 * Assertions below go through `@oxyhq/db`'s driver-error helpers rather than
 * matching the message, because **drizzle wraps the driver failure in its own
 * error**: `code` and `constraint_name` live on `cause`, and the wrapper's
 * message is only `Failed query: …`. A regex against that message passes or
 * fails for reasons unrelated to the constraint under test — which this suite
 * demonstrated by failing on exactly that the first time it ran.
 *
 * Naming the CONSTRAINT matters too: `isUniqueViolation` alone cannot tell "the
 * index I am testing fired" from "some other index on the same table fired".
 */
async function errorFrom(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('Expected the operation to be rejected by the database, but it succeeded');
}

beforeAll(() => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('globalSetup did not publish DATABASE_URL');
  db = connectPostgres(url);
});

afterAll(async () => {
  await closePostgres();
});

describe('closed value sets are enforced by the database', () => {
  it('accepts a declared status', async () => {
    await db.insert(whatsappSessions).values({
      sessionId: 'wa-ok',
      oxyUserId: 'user-1',
      status: 'connected',
    });
    const [row] = await db
      .select()
      .from(whatsappSessions)
      .where(eq(whatsappSessions.sessionId, 'wa-ok'));
    expect(row?.status).toBe('connected');
  });

  it('REJECTS a status outside the tuple', async () => {
    /**
     * The load-bearing case. `text({ enum })` emits no DDL, so without the
     * explicit CHECK this write would succeed and the column would be
     * constrained only in the editor.
     *
     * Written as raw SQL on purpose rather than a type-suppressed drizzle call.
     * The narrowing is not what is under test — the DATABASE is — and the threat
     * the CHECK answers is precisely a writer that never passed through this
     * package's types: a psql session, a backfill script, or a future service.
     */
    const error = await errorFrom(
      db.execute(sql`
        insert into whatsapp_sessions (session_id, oxy_user_id, status)
        values ('wa-bad', 'user-1', 'not-a-real-status')
      `),
    );
    expect(isCheckViolation(error)).toBe(true);
    expect(constraintNameOf(error)).toBe('whatsapp_sessions_status_check');
  });

  it('applies the declared default', async () => {
    await db.insert(whatsappSessions).values({ sessionId: 'wa-def', oxyUserId: 'user-1' });
    const [row] = await db
      .select()
      .from(whatsappSessions)
      .where(eq(whatsappSessions.sessionId, 'wa-def'));
    expect(row?.status).toBe('qr-pending');
  });
});

describe('a session owns its chats and messages', () => {
  it('CASCADES to chats and messages on delete', async () => {
    /**
     * Mongo could not express this: deleting a session there orphaned every
     * chat and message that referenced it, and nothing ever collected them.
     */
    await db.insert(whatsappSessions).values({ sessionId: 'wa-cascade', oxyUserId: 'user-2' });
    await db.insert(whatsappChats).values({
      id: 'chat-1',
      sessionId: 'wa-cascade',
      oxyUserId: 'user-2',
      jid: '111@s.whatsapp.net',
    });
    await db.insert(whatsappMessages).values({
      id: 'msg-1',
      sessionId: 'wa-cascade',
      oxyUserId: 'user-2',
      jid: '111@s.whatsapp.net',
      messageId: 'm1',
      timestamp: 1_700_000_000,
    });

    await db.delete(whatsappSessions).where(eq(whatsappSessions.sessionId, 'wa-cascade'));

    expect(
      await db.select().from(whatsappChats).where(eq(whatsappChats.sessionId, 'wa-cascade')),
    ).toHaveLength(0);
    expect(
      await db.select().from(whatsappMessages).where(eq(whatsappMessages.sessionId, 'wa-cascade')),
    ).toHaveLength(0);
  });

  it('refuses a chat whose session does not exist', async () => {
    const error = await errorFrom(
      db.insert(whatsappChats).values({
        id: 'chat-orphan',
        sessionId: 'wa-nonexistent',
        oxyUserId: 'user-2',
        jid: '222@s.whatsapp.net',
      }),
    );
    expect(isForeignKeyViolation(error)).toBe(true);
  });
});

describe('protocol ids are unique per session', () => {
  it('refuses a duplicate (session, messageId)', async () => {
    await db.insert(whatsappSessions).values({ sessionId: 'wa-dup', oxyUserId: 'user-3' });
    const message = {
      sessionId: 'wa-dup',
      oxyUserId: 'user-3',
      jid: '333@s.whatsapp.net',
      messageId: 'same-id',
      timestamp: 1_700_000_001,
    };
    await db.insert(whatsappMessages).values({ id: 'msg-a', ...message });

    const error = await errorFrom(db.insert(whatsappMessages).values({ id: 'msg-b', ...message }));
    expect(isUniqueViolation(error)).toBe(true);
    expect(constraintNameOf(error)).toBe('whatsapp_messages_session_message_key');
  });

  it('allows the SAME protocol id under a different session', async () => {
    await db.insert(whatsappSessions).values({ sessionId: 'wa-other', oxyUserId: 'user-3' });
    await db.insert(whatsappMessages).values({
      id: 'msg-c',
      sessionId: 'wa-other',
      oxyUserId: 'user-3',
      jid: '333@s.whatsapp.net',
      messageId: 'same-id',
      timestamp: 1_700_000_002,
    });
    const rows = await db
      .select()
      .from(whatsappMessages)
      .where(eq(whatsappMessages.messageId, 'same-id'));
    expect(rows).toHaveLength(2);
  });
});

describe('credentials survive a round trip unchanged', () => {
  it('stores a Baileys auth blob as jsonb without reshaping it', async () => {
    const authState = { creds: { noiseKey: { private: 'x', public: 'y' } }, me: { id: '1@s' } };
    const authKeys = { 'pre-key': { '1': { public: 'k' } } };
    await db
      .insert(whatsappSessions)
      .values({ sessionId: 'wa-auth', oxyUserId: 'user-4', authState, authKeys });

    const [row] = await db
      .select()
      .from(whatsappSessions)
      .where(eq(whatsappSessions.sessionId, 'wa-auth'));
    expect(row?.authState).toEqual(authState);
    expect(row?.authKeys).toEqual(authKeys);
  });

  it('defaults authKeys to an empty object, not null', async () => {
    await db.insert(whatsappSessions).values({ sessionId: 'wa-nokeys', oxyUserId: 'user-4' });
    const [row] = await db
      .select()
      .from(whatsappSessions)
      .where(eq(whatsappSessions.sessionId, 'wa-nokeys'));
    expect(row?.authKeys).toEqual({});
    expect(row?.authState).toBeNull();
  });

  it('keeps a Telegram session string byte-identical', async () => {
    const sessionString = '1BQANOTEuMTA4LjU2LjE3MwG7' + 'x'.repeat(300);
    await db
      .insert(telegramSessions)
      .values({ sessionId: 'tg-1', oxyUserId: 'user-5', sessionString });
    const [row] = await db
      .select()
      .from(telegramSessions)
      .where(eq(telegramSessions.sessionId, 'tg-1'));
    expect(row?.sessionString).toBe(sessionString);
  });
});

describe('the MCP OAuth upsert converges', () => {
  it('creates once and returns the same row on a repeat', async () => {
    /**
     * Replaces `getOrCreateConnectorAuth`'s Mongo upsert. Two concurrent OAuth
     * callbacks for one (user, server) must converge on a single row rather
     * than racing two half-finished authorizations.
     */
    const values = { id: 'auth-1', oxyUserId: 'user-6', serverId: 'notion' };
    await db.insert(mcpConnectorAuths).values(values).onConflictDoNothing();
    await db
      .insert(mcpConnectorAuths)
      .values({ ...values, id: 'auth-2' })
      .onConflictDoNothing();

    const rows = await db
      .select()
      .from(mcpConnectorAuths)
      .where(
        and(
          eq(mcpConnectorAuths.oxyUserId, 'user-6'),
          eq(mcpConnectorAuths.serverId, 'notion'),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('auth-1');
  });

  it('separates the same user on a different server', async () => {
    await db
      .insert(mcpConnectorAuths)
      .values({ id: 'auth-3', oxyUserId: 'user-6', serverId: 'linear' })
      .onConflictDoNothing();
    const rows = await db
      .select()
      .from(mcpConnectorAuths)
      .where(eq(mcpConnectorAuths.oxyUserId, 'user-6'));
    expect(rows).toHaveLength(2);
  });
});
