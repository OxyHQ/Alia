/**
 * One active voice call per person, across devices and tabs (ADR 0017 §3a).
 *
 * A new `session.start` TAKES OVER: the previous call hangs up with
 * `call-moved-elsewhere` and the new one goes on.
 *
 * - **Authority is PostgreSQL** (`db/voice/voiceCallRepository.ts`): the
 *   takeover ends the old row and inserts the new one in one transaction under
 *   a per-person advisory lock; a partial unique index makes two active rows
 *   impossible.
 * - **Same task:** the old call is in this task's registry and is hung up
 *   directly.
 * - **Another task:** a `takeover` message on the Redis channel reaches the
 *   holder, which hangs up within milliseconds — the cross-task pattern of
 *   `lib/inference/user-runtime-bridge.ts`.
 * - **No Redis, or a lost message:** the lease decides. Every task renews its
 *   calls every {@link LEASE_RENEW_MS}; a renewal that matches no active row
 *   means the call was taken over, and the holder hangs up. The worst overlap
 *   is one renewal interval.
 *
 * The holder of a call taken over flushes its messages, closes its Kaana
 * session and then announces `ended`; the new call waits for that at most
 * {@link PREVIOUS_CALL_WAIT_MS} before building its instructions, so the last
 * exchange of the old call is in them.
 */

import crypto from 'node:crypto';
import os from 'node:os';
import { getDb } from '../../db/index.js';
import type { VoiceCallEndReason } from '../../db/schema/voice.js';
import {
  endVoiceCall,
  renewVoiceCallLease,
  takeOverVoiceCall,
} from '../../db/voice/voiceCallRepository.js';
import { log } from '../logger.js';
import { getRedisClient } from '../redis.js';

export const LEASE_RENEW_MS = 10_000;
/** Three missed renewals: a crashed task's row reads as expired soon after. */
export const LEASE_MS = 30_000;
export const PREVIOUS_CALL_WAIT_MS = 2_000;

const REDIS_CHANNEL = 'alia:voice-call';

/** This API task. Hostname pins the ECS task; pid and random tell restarts apart. */
export const VOICE_TASK_ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;

/** What the registry needs of a call it holds. */
export interface HeldCall {
  /** Hang up because another device took the call over. Resolves once flushed and closed. */
  takenOver(): Promise<void>;
}

type ChannelMessage = { kind: 'takeover'; callId: string } | { kind: 'ended'; callId: string };

const held = new Map<string, HeldCall>();
/** Waiters for `ended` of a call held elsewhere, by call id. */
const endedWaiters = new Map<string, Array<() => void>>();
let renewTimer: NodeJS.Timeout | null = null;
let subscriberStarted = false;

/** Test seam: the clock and the renewal interval. */
let renewIntervalMs = LEASE_RENEW_MS;
export function setVoiceLeaseRenewIntervalForTests(ms: number): void {
  renewIntervalMs = ms;
  if (renewTimer) {
    clearInterval(renewTimer);
    renewTimer = null;
    ensureRenewal();
  }
}

function publish(message: ChannelMessage): void {
  const client = getRedisClient();
  if (!client) return;
  client.publish(REDIS_CHANNEL, JSON.stringify(message)).catch((err: Error) => {
    log.general.warn({ err, kind: message.kind }, 'voice-call message not published');
  });
}

function ensureSubscriber(): void {
  if (subscriberStarted) return;
  subscriberStarted = true;
  const client = getRedisClient();
  if (!client) return;
  const subscriber = client.duplicate();
  subscriber.on('error', (err: Error) => log.general.warn({ err }, 'voice-call subscriber error'));
  subscriber.on('message', (_channel: string, raw: string) => {
    let message: ChannelMessage;
    try {
      message = JSON.parse(raw) as ChannelMessage;
    } catch {
      return;
    }
    if (message.kind === 'takeover') {
      const call = held.get(message.callId);
      if (call) void hangUpTakenOver(message.callId, call);
    } else if (message.kind === 'ended') {
      settleEnded(message.callId);
    }
  });
  subscriber.subscribe(REDIS_CHANNEL).catch((err: Error) => {
    log.general.warn({ err }, 'voice-call subscribe failed — takeovers fall back to the lease');
  });
}

function settleEnded(callId: string): void {
  const waiters = endedWaiters.get(callId);
  if (!waiters) return;
  endedWaiters.delete(callId);
  for (const resolve of waiters) resolve();
}

function waitForEnded(callId: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      const waiters = endedWaiters.get(callId)?.filter((waiter) => waiter !== done);
      if (waiters && waiters.length > 0) endedWaiters.set(callId, waiters);
      else endedWaiters.delete(callId);
      resolve();
    }, timeoutMs);
    timer.unref?.();
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    endedWaiters.set(callId, [...(endedWaiters.get(callId) ?? []), done]);
  });
}

async function hangUpTakenOver(callId: string, call: HeldCall): Promise<void> {
  if (held.get(callId) !== call) return;
  held.delete(callId);
  try {
    await call.takenOver();
  } catch (err) {
    log.general.warn({ err, callId }, 'A taken-over voice call did not close cleanly');
  }
  settleEnded(callId);
  publish({ kind: 'ended', callId });
}

function ensureRenewal(): void {
  if (renewTimer || held.size === 0) return;
  renewTimer = setInterval(() => void renewAll(), renewIntervalMs);
  renewTimer.unref?.();
}

async function renewAll(): Promise<void> {
  if (held.size === 0) {
    if (renewTimer) clearInterval(renewTimer);
    renewTimer = null;
    return;
  }
  await Promise.all(
    [...held.entries()].map(async ([callId, call]) => {
      try {
        const live = await renewVoiceCallLease(getDb(), callId, LEASE_MS);
        if (!live) await hangUpTakenOver(callId, call);
      } catch (err) {
        // A database blip is not a takeover: the next renewal decides.
        log.general.warn({ err, callId }, 'voice-call lease renewal failed');
      }
    }),
  );
}

/**
 * Make this call the person's only active one and hang up any other. Resolves
 * once the previous call has announced its end, or after
 * {@link PREVIOUS_CALL_WAIT_MS}, whichever comes first.
 */
export async function startCall(input: {
  readonly callId: string;
  readonly oxyUserId: string;
  readonly conversationId: string;
  readonly agentId: string | null;
  readonly call: HeldCall;
}): Promise<{ replaced: number }> {
  ensureSubscriber();
  const replaced = await takeOverVoiceCall(getDb(), {
    id: input.callId,
    oxyUserId: input.oxyUserId,
    conversationId: input.conversationId,
    agentId: input.agentId,
    holderTask: VOICE_TASK_ID,
    leaseMs: LEASE_MS,
  });
  held.set(input.callId, input.call);
  ensureRenewal();

  await Promise.all(
    replaced.map(async (previous) => {
      const local = held.get(previous.id);
      if (local) {
        await Promise.race([
          hangUpTakenOver(previous.id, local),
          new Promise<void>((resolve) => setTimeout(resolve, PREVIOUS_CALL_WAIT_MS).unref?.()),
        ]);
        return;
      }
      const ended = waitForEnded(previous.id, PREVIOUS_CALL_WAIT_MS);
      publish({ kind: 'takeover', callId: previous.id });
      await ended;
    }),
  );
  return { replaced: replaced.length };
}

/** The call ended on this task for its own reason: the row is ended and others are told. */
export async function finishCall(callId: string, reason: VoiceCallEndReason): Promise<void> {
  const wasHeld = held.delete(callId);
  try {
    await endVoiceCall(getDb(), callId, reason);
  } catch (err) {
    // The lease lapses on its own; a takeover ends the row regardless.
    log.general.warn({ err, callId }, 'voice-call row could not be ended');
  }
  if (wasHeld) {
    settleEnded(callId);
    publish({ kind: 'ended', callId });
  }
}

/** Whether this task holds the call (for tests and the shutdown drain). */
export function holdsCall(callId: string): boolean {
  return held.has(callId);
}

/** Test seam: forget every held call without touching the database. */
export function resetCallRegistryForTests(): void {
  held.clear();
  endedWaiters.clear();
  if (renewTimer) clearInterval(renewTimer);
  renewTimer = null;
  renewIntervalMs = LEASE_RENEW_MS;
}
