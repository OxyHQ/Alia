import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { isUniqueViolation } from '@oxy.so/db';
import { closePostgres, connectPostgres, getDb } from '../../../db/index.js';
import { voiceCalls } from '../../../db/schema/voice.js';
import {
  endVoiceCall,
  findActiveVoiceCalls,
  renewVoiceCallLease,
  takeOverVoiceCall,
} from '../../../db/voice/voiceCallRepository.js';
import {
  finishCall,
  resetCallRegistryForTests,
  setVoiceLeaseRenewIntervalForTests,
  startCall,
} from '../call-registry.js';

/**
 * One active voice call per person, against a real Postgres (ADR 0017 §3a,
 * Enforcement): two concurrent takeovers leave exactly one active row, the
 * partial unique index refuses a second one that bypasses the lock, and a
 * holder whose lease renewal touches no row hangs up as moved elsewhere.
 *
 * Without `REDIS_URL` the cross-task message is not sent, so these exercise the
 * lease — the path that must work when Redis does not.
 */

beforeAll(() => {
  if (!connectPostgres(process.env.DATABASE_URL)) throw new Error('Test DB required');
});
afterAll(closePostgres);
afterEach(() => resetCallRegistryForTests());

const person = () => `voice-person-${randomUUID()}`;

function call(oxyUserId: string, holderTask = 'task-a') {
  return {
    id: `vc_${randomUUID()}`,
    oxyUserId,
    conversationId: `conv-${randomUUID()}`,
    agentId: null,
    holderTask,
    leaseMs: 30_000,
  };
}

describe('voice_calls', () => {
  it('leaves exactly one active row after two concurrent takeovers for one person', async () => {
    const user = person();
    const first = call(user, 'task-a');
    const second = call(user, 'task-b');
    const [a, b] = await Promise.all([
      takeOverVoiceCall(getDb(), first),
      takeOverVoiceCall(getDb(), second),
    ]);
    const active = await findActiveVoiceCalls(getDb(), user);
    expect(active).toHaveLength(1);
    // Whoever went second ended the first one: exactly one takeover replaced a call.
    expect([...a, ...b]).toHaveLength(1);
    const ended = [...a, ...b][0]!;
    expect([first.id, second.id]).toContain(ended.id);
    expect(active[0]!.id).not.toBe(ended.id);
  });

  it('refuses a second active row for one person at the index, whatever bypasses the lock', async () => {
    const user = person();
    await takeOverVoiceCall(getDb(), call(user));
    const error = await getDb()
      .insert(voiceCalls)
      .values({
        id: `vc_${randomUUID()}`,
        oxyUserId: user,
        conversationId: 'c',
        holderTask: 't',
        status: 'active',
        leaseExpiresAt: new Date(Date.now() + 30_000),
      })
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(isUniqueViolation(error, 'voice_calls_one_active_per_user')).toBe(true);
  });

  it('a renewal of a taken-over call touches no row; an ended call cannot be ended twice', async () => {
    const user = person();
    const old = call(user);
    await takeOverVoiceCall(getDb(), old);
    expect(await renewVoiceCallLease(getDb(), old.id, 30_000)).toBe(true);
    const replaced = await takeOverVoiceCall(getDb(), call(user, 'task-b'));
    expect(replaced).toEqual([{ id: old.id, holderTask: 'task-a' }]);
    expect(await renewVoiceCallLease(getDb(), old.id, 30_000)).toBe(false);
    expect(await endVoiceCall(getDb(), old.id, 'hangup')).toBe(false);
  });

  it('an expired lease never blocks a new call', async () => {
    const user = person();
    const crashed = call(user, 'task-dead');
    await takeOverVoiceCall(getDb(), { ...crashed, leaseMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const replaced = await takeOverVoiceCall(getDb(), call(user));
    expect(replaced.map((row) => row.id)).toEqual([crashed.id]);
    expect(await findActiveVoiceCalls(getDb(), user)).toHaveLength(1);
  });
});

describe('the registry', () => {
  it('hangs up the previous call on this task directly, and waits for it before going on', async () => {
    const user = person();
    const order: string[] = [];
    const oldCall = {
      takenOver: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('old ended');
      }),
    };
    const first = call(user);
    await startCall({
      callId: first.id,
      oxyUserId: user,
      conversationId: 'c1',
      agentId: null,
      call: oldCall,
    });
    const second = call(user);
    const result = await startCall({
      callId: second.id,
      oxyUserId: user,
      conversationId: 'c1',
      agentId: null,
      call: { takenOver: vi.fn(async () => undefined) },
    });
    order.push('new goes on');
    expect(result.replaced).toBe(1);
    expect(oldCall.takenOver).toHaveBeenCalledOnce();
    expect(order).toEqual(['old ended', 'new goes on']);
    await finishCall(second.id, 'hangup');
    expect(await findActiveVoiceCalls(getDb(), user)).toHaveLength(0);
  });

  it('a holder whose lease renewal touches no row hangs up (another task took the call)', async () => {
    setVoiceLeaseRenewIntervalForTests(15);
    const user = person();
    const held = { takenOver: vi.fn(async () => undefined) };
    const mine = call(user);
    await startCall({
      callId: mine.id,
      oxyUserId: user,
      conversationId: 'c',
      agentId: null,
      call: held,
    });
    // Another task takes over through the database alone, as without Redis.
    await takeOverVoiceCall(getDb(), call(user, 'task-elsewhere'));
    const deadline = Date.now() + 5_000;
    while (held.takenOver.mock.calls.length === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(held.takenOver).toHaveBeenCalledOnce();
    const active = await findActiveVoiceCalls(getDb(), user);
    expect(active).toHaveLength(1);
    expect(active[0]!.holderTask).toBe('task-elsewhere');
  });
});
