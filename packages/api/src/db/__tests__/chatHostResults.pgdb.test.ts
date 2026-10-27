import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../index';
import { hostResultRepository } from '../chat/hostResultRepository';
import { chatHostResults } from '../schema/chat-host-results';
import { HostResultWaiter } from '../../lib/chat/host-results';

beforeAll(() => {
  if (!connectPostgres(process.env.DATABASE_URL)) throw new Error('Missing fixture DB');
});
afterAll(closePostgres);

describe('awaited host results', () => {
  const key = () => ({ turnId: randomUUID(), toolCallId: 'call-1', authorityKey: randomUUID() });
  const rowsOf = (turnId: string) =>
    getDb().select().from(chatHostResults).where(eq(chatHostResults.turnId, turnId));

  it('accepts one answer under the turn’s authority, and hands it over exactly once', async () => {
    const repo = hostResultRepository(getDb());
    const turn = key();
    await repo.open(turn);
    await repo.open(turn);
    await expect(
      repo.answer({ ...turn, authorityKey: 'someone-else' }, { outcome: 'applied' }),
    ).rejects.toMatchObject({ code: 'host_result_not_found' });
    await expect(
      repo.answer({ ...turn, toolCallId: 'never-dispatched' }, { outcome: 'applied' }),
    ).rejects.toMatchObject({ code: 'host_result_not_found' });

    const page = { title: 'Docs', text: 'Hello, world' };
    await repo.answer(turn, { outcome: 'applied', detail: 'read', result: page });
    await expect(repo.answer(turn, { outcome: 'failed' })).rejects.toMatchObject({
      code: 'host_result_already_answered',
    });

    expect(await repo.take([turn, { ...turn, toolCallId: 'other' }])).toEqual([
      {
        turnId: turn.turnId,
        toolCallId: 'call-1',
        answer: { outcome: 'applied', detail: 'read', result: page },
      },
    ]);
    expect(await rowsOf(turn.turnId)).toEqual([]);
    expect(await repo.take([turn])).toEqual([]);
    await expect(repo.answer(turn, { outcome: 'applied' })).rejects.toMatchObject({
      code: 'host_result_not_found',
    });
  });

  it('keeps a string result a string, and reads nothing from a pending row', async () => {
    const repo = hostResultRepository(getDb());
    const turn = key();
    await repo.open(turn);
    expect(await repo.take([turn])).toEqual([]);
    await repo.answer(turn, { outcome: 'inline', result: 'plain text' });
    const [taken] = await repo.take([turn]);
    expect(taken?.answer).toEqual({ outcome: 'inline', result: 'plain text' });
  });

  it('closes a wait: an unanswered row is gone, an answer that raced the close is kept', async () => {
    const repo = hostResultRepository(getDb());
    const silent = key();
    await repo.open(silent);
    expect(await repo.close(silent)).toBeNull();
    expect(await rowsOf(silent.turnId)).toEqual([]);

    const raced = key();
    await repo.open(raced);
    await repo.answer(raced, { outcome: 'rejected', detail: 'No tab' });
    expect(await repo.close(raced)).toEqual({ outcome: 'rejected', detail: 'No tab' });
    expect(await rowsOf(raced.turnId)).toEqual([]);
  });

  it('refuses an answered row without its outcome, and an outcome outside the contract', async () => {
    const turnId = randomUUID();
    await expect(
      getDb().execute(
        sql`INSERT INTO chat_host_results (turn_id, tool_call_id, authority_key, state, expires_at)
            VALUES (${turnId}, 'c', 'a', 'answered', now() + interval '1 hour')`,
      ),
    ).rejects.toThrow();
    await expect(
      getDb().execute(
        sql`INSERT INTO chat_host_results (turn_id, tool_call_id, authority_key, state, outcome, answered_at, expires_at)
            VALUES (${turnId}, 'c', 'a', 'answered', 'done', now(), now() + interval '1 hour')`,
      ),
    ).rejects.toThrow();
  });

  it('carries an answer received on one replica to the turn waiting on another', async () => {
    const streaming = new HostResultWaiter(hostResultRepository(getDb()), 50);
    const receiving = hostResultRepository(getDb());
    const turn = key();
    await streaming.open(turn);
    const waiting = streaming.wait(turn, undefined, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 120));
    await receiving.answer(turn, { outcome: 'applied', result: { tabs: 3 } });
    await expect(waiting).resolves.toEqual({ outcome: 'applied', result: { tabs: 3 } });
    expect(await rowsOf(turn.turnId)).toEqual([]);
  });

  it('ends a wait at its deadline and leaves nothing behind', async () => {
    const waiter = new HostResultWaiter(hostResultRepository(getDb()), 50);
    const turn = key();
    await waiter.open(turn);
    await expect(waiter.wait(turn, undefined, 200)).resolves.toBeNull();
    expect(await rowsOf(turn.turnId)).toEqual([]);
    await expect(
      hostResultRepository(getDb()).answer(turn, { outcome: 'applied' }),
    ).rejects.toMatchObject({ code: 'host_result_not_found' });
  });
});
