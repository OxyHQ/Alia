/**
 * Answering a stored inbound message, and recovering the ones whose answerer
 * died.
 *
 * The webhook writes the message (`channel_inbound`) BEFORE it acks the
 * platform, then calls {@link processAcceptedChannelInbound}. If the process
 * dies in between, the platform never redelivers (it was acked) and the person
 * hears nothing; {@link reapStalledChannelInbound} finds that row and answers it
 * from another instance. One retry at most: a second reply is a worse outcome
 * than a quiet failure.
 *
 * Not leader-gated. Every transition is a conditional UPDATE, so N instances
 * never answer one message twice.
 */

import { findBotUserById, findInboundUserBotById } from '../../db/integrations/botRepository.js';
import {
  claimChannelInbound,
  claimStalledChannelInbound,
  purgeChannelInbound,
  settleChannelInbound,
  type ChannelInboundWork,
} from '../../db/integrations/channelInboundRepository.js';
import { getDb } from '../../db/index.js';
import { log } from '../logger.js';
import { processAgentBotMessage, processChannelMessage } from './inbound-handlers.js';
import type { ChannelId } from './types.js';

/** A healthy reply starts within seconds; this is past the slowest one. */
const INBOUND_STALLED_AFTER_MS = 2 * 60_000;
/** A message this old is no longer worth answering. */
const INBOUND_MAX_AGE_MS = 60 * 60_000;
/** The first try plus one retry. */
const INBOUND_MAX_ATTEMPTS = 2;
const SWEEP_BATCH = 25;
const SETTLED_KEPT_MS = 60 * 60_000;

async function run(work: ChannelInboundWork): Promise<void> {
  const db = getDb();
  const botUser = await findBotUserById(db, work.botUserId);
  if (!botUser) {
    log.webhook.warn({ inboundId: work.id }, 'Inbound message has no bot user; dropped');
    await settleChannelInbound(db, work.id, 'failed');
    return;
  }
  const channelType = work.channelType as ChannelId;
  try {
    if (work.kind === 'agent_bot') {
      const bot = await findInboundUserBotById(db, work.botId);
      if (!bot) {
        await settleChannelInbound(db, work.id, 'failed');
        return;
      }
      await processAgentBotMessage(bot, botUser, work.message, channelType);
    } else {
      await processChannelMessage(channelType, botUser, work.message);
    }
    await settleChannelInbound(db, work.id, 'done');
  } catch (error: unknown) {
    log.webhook.error({ err: error, channelType, inboundId: work.id }, 'Inbound processing error');
    await settleChannelInbound(db, work.id, 'failed').catch(() => undefined);
  }
}

/** The fast path: answer the message this instance just accepted. */
export async function processAcceptedChannelInbound(id: string): Promise<void> {
  const work = await claimChannelInbound(getDb(), id);
  if (work) await run(work);
}

/** Answer the messages a dead instance left unfinished. Returns how many it took. */
export async function reapStalledChannelInbound(now: Date = new Date()): Promise<number> {
  const db = getDb();
  const stalled = await claimStalledChannelInbound(db, {
    now,
    staleMs: INBOUND_STALLED_AFTER_MS,
    maxAgeMs: INBOUND_MAX_AGE_MS,
    maxAttempts: INBOUND_MAX_ATTEMPTS,
    limit: SWEEP_BATCH,
  });
  for (const work of stalled) await run(work);
  if (stalled.length > 0) {
    log.webhook.warn({ count: stalled.length }, 'Answered inbound messages left unfinished');
  }
  await purgeChannelInbound(db, {
    now,
    settledMs: SETTLED_KEPT_MS,
    abandonedMs: INBOUND_MAX_AGE_MS,
  });
  return stalled.length;
}
