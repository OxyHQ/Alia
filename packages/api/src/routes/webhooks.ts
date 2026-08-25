import express from 'express';
import crypto from 'crypto';
import { verifySecret } from '@oxyhq/core/server';
import { generateText, stepCountIs } from 'ai';
import { getChannel } from '../lib/channels/registry.js';
import { resolveModel, getAIModel, reportModelUsage, getDefaultAliaModel } from '../lib/chat-core.js';
import { sendChannelMessage } from '../lib/channels/outbound.js';
import { ToolPipeline } from '../lib/tool-pipeline.js';
import { attachAgentIdentity } from '../lib/agent-identity.js';
import { loadPrompt } from '../lib/prompt-loader.js';
import { getDb } from '../db/index.js';
import {
  findActiveUserBotByWebhookSecret,
  findSystemBot,
  setBotUserAuthToken,
  setBotUserConversation,
  upsertBotUser,
  type BotRow,
  type BotUserRow,
  type InboundUserBotRow,
} from '../db/integrations/botRepository.js';
import { findAgentById } from '../db/agents/agentRepository.js';
import { upsertConversation } from '../db/chat/conversationRepository.js';
import { insertMessages, listRecentTurns } from '../db/chat/messageRepository.js';
import { getOrCreateUserCredits } from '../lib/user-credits-helpers.js';
import { reserveCredits, finalizeCredits, safeRefund, type CreditReservation, type CreditUsage } from '../lib/credits-manager.js';
import type { ChannelId, ChannelInboundMessage } from '../lib/channels/types.js';
import { log } from '../lib/logger.js';
import { toRoutableAlias } from '../lib/product-modes.js';

const DEFAULT_CHANNEL_PROMPT = `You are Alia, an AI assistant by Oxy. Be concise and direct — this is a messaging channel.

CRITICAL: Respond in the same language the user writes to you.

- Skip preambles ("Sure!", "Of course!"). Get to the point.
- Keep responses short. A few sentences is usually enough.
- Be honest about uncertainty.
- When the request is unclear, make a reasonable assumption and state it briefly.`;

/** Map channel types to their dedicated prompt files (when available). */
const CHANNEL_PROMPT_MAP: Partial<Record<ChannelId, string>> = {
  telegram: 'alia-telegram',
};

async function getChannelSystemPrompt(channelType: ChannelId): Promise<string> {
  const promptName = CHANNEL_PROMPT_MAP[channelType];
  if (!promptName) return DEFAULT_CHANNEL_PROMPT;

  const prompt = await loadPrompt(promptName);
  return prompt || DEFAULT_CHANNEL_PROMPT;
}

/**
 * Deduplication map: prevents processing the same webhook message twice.
 * Key format: `${channelType}:${platformUserId}:${messageId || hash(text)}`
 * Entries are automatically removed after 60 seconds.
 */
const processedWebhookMessages = new Set<string>();

export function getDeduplicationKey(
  channelType: ChannelId,
  message: ChannelInboundMessage,
  scope?: string,
): string {
  const contentHash = crypto.createHash('md5').update(message.text).digest('hex').slice(0, 12);
  // `scope` isolates per-bot dedup: platformUserId is the same Telegram user id
  // across all bots, so without the receiving bot's id in the key, one person
  // texting two different bots the same thing within 60s would drop the second.
  return `${channelType}:${scope ? `${scope}:` : ''}${message.platformUserId}:${contentHash}`;
}

function isDuplicate(channelType: ChannelId, message: ChannelInboundMessage, scope?: string): boolean {
  const key = getDeduplicationKey(channelType, message, scope);
  if (processedWebhookMessages.has(key)) return true;
  processedWebhookMessages.add(key);
  setTimeout(() => processedWebhookMessages.delete(key), 60000);
  return false;
}

/**
 * Per-(bot, end-user) inbound rate limit for user-registered agent bots.
 *
 * A user's agent bot is public: anyone on Telegram can message it, and every
 * reply is billed to the bot OWNER. Credits already bound total spend, but this
 * stops a single sender from rapidly burning the owner's balance. Excess is
 * dropped silently (acked, never processed → no credit spend). In-memory /
 * per-instance (an owner's bot across ECS tasks gets N× this); a Redis-backed
 * limiter would make it exact — a fine future upgrade, but credits are the hard
 * cap either way.
 */
const BOT_RL_WINDOW_MS = 60_000;
const BOT_RL_MAX_PER_USER = 15;
const botUserHits = new Map<string, number[]>();

export function isBotUserRateLimited(botId: string, platformUserId: string): boolean {
  const key = `${botId}:${platformUserId}`;
  const now = Date.now();
  const recent = (botUserHits.get(key) ?? []).filter((t) => t > now - BOT_RL_WINDOW_MS);
  if (recent.length >= BOT_RL_MAX_PER_USER) {
    botUserHits.set(key, recent);
    return true;
  }
  recent.push(now);
  botUserHits.set(key, recent);
  return false;
}

// Sweep stale keys so the map can't grow unbounded. unref() so this housekeeping
// timer never keeps the process (or jest) alive.
const botRlSweep = setInterval(() => {
  const cutoff = Date.now() - BOT_RL_WINDOW_MS;
  for (const [key, hits] of botUserHits) {
    const recent = hits.filter((t) => t > cutoff);
    if (recent.length === 0) botUserHits.delete(key);
    else botUserHits.set(key, recent);
  }
}, BOT_RL_WINDOW_MS);
botRlSweep.unref?.();

function generateAuthToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Answer one inbound message on the shared system bot, and bill the linked
 * account for it.
 *
 * EXPORTED because the route drops this promise on the floor: it acks the
 * platform (Slack gives it three seconds) and calls this fire-and-forget. There
 * is no response to inspect and no caller to await, so a test that drives the
 * route observes nothing about what happens in here — including whether the
 * credit it reserved came back.
 */
export async function processChannelMessage(
  channelType: ChannelId,
  botUser: BotUserRow,
  message: ChannelInboundMessage
): Promise<void> {
  const db = getDb();
  /**
   * Out here so the `finally` can see them, and `creditsSettled` so no exit can
   * both charge and refund.
   *
   * `reserveCredits` DEBITS on the way in, and this handler has several exits
   * that answer a problem by messaging the person and returning — no model
   * available, an exception anywhere. Each one used to keep the credit. Nothing
   * reported it: the route acked the platform long before any of this ran, so
   * the only trace was a balance one lower than it should have been.
   *
   * The same release `routes/v1/chat-completions.ts` puts in ONE `finally`, for
   * the same reason: an exit that has to remember is an exit that will forget.
   */
  let creditReservation: CreditReservation | null = null;
  let creditsSettled = false;
  try {
    // Check if user has linked their Alia account
    if (!botUser.isLinked || !botUser.oxyUserId) {
      // Generate auth token and send auth link
      const authToken = generateAuthToken();
      await setBotUserAuthToken(db, botUser.id, authToken, new Date(Date.now() + 15 * 60 * 1000));

      const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:4150';
      const authUrl = `${apiBaseUrl}/bots/internal/${channelType}/verify?token=${authToken}`;

      await sendChannelMessage(
        channelType,
        message.chatId,
        `Hi! To use Alia, please link your account first:\n${authUrl}\n\nThis link expires in 15 minutes.`,
        { replyToId: message.replyToId, threadId: message.threadId }
      );
      return;
    }

    const userId = botUser.oxyUserId.toString();
    /**
     * The stored preference is now `profile:*`, so it has to be translated.
     *
     * `packages/integrations`' `/model` command writes what `GET /catalogue`
     * publishes (#244), and this column is shared with that service — the same
     * `bot_users.preferred_model` row feeds both. Everything below wants the
     * ALIAS: `resolveModel` looks it up in `ALIA_MODELS` and `finalizeCredits`
     * bills on its `credit_multiplier`, and neither knows the profile
     * vocabulary. This is the same translation `lib/chat/request-context.ts`
     * does at the chat boundary, for the same reason.
     *
     * A legacy `alia-*` passes through untouched, and `null` — a `profile:` id
     * no preset defines, so a tier retired after somebody selected it — falls
     * back to the product default rather than leaving that person with a bot
     * that answers nothing. The fallback is logged because it means a stored
     * preference has gone stale.
     */
    const preferred = botUser.preferredModel || getDefaultAliaModel();
    const routable = toRoutableAlias(preferred);
    if (routable === null) {
      log.channels.warn({ preferred }, 'Stored bot model preference names no routing profile');
    }
    const aliasModelId = routable ?? getDefaultAliaModel();

    // Reserve credits before processing
    await getOrCreateUserCredits(userId);

    creditReservation = await reserveCredits(userId);
    if (!creditReservation) {
      const appUrl = process.env.APP_URL || process.env.WEB_URL || 'https://alia.onl';
      await sendChannelMessage(
        channelType,
        message.chatId,
        `You've run out of credits. Add more at ${appUrl} to continue using Alia.`,
        { replyToId: message.replyToId, threadId: message.threadId }
      );
      return;
    }

    // Load or create conversation
    let conversationId = botUser.conversationId;
    if (!conversationId) {
      conversationId = crypto.randomUUID();
      await setBotUserConversation(db, botUser.id, conversationId);
    }

    /**
     * Load conversation history.
     *
     * `listRecentTurns` narrows to string bodies in the DATABASE, so a
     * multi-part message is dropped rather than rendered as an empty line. Only
     * this path writes these threads and it writes strings, so nothing that
     * exists today is affected.
     */
    let messages: Array<{ role: string; content: string }> = [];
    try {
      messages = [...await listRecentTurns(db, botUser.oxyUserId, conversationId, 20)];
    } catch (error: unknown) {
      log.webhook.error({ err: error, channelType }, 'Failed to load conversation history');
    }

    // Add the new user message, stamped when it ARRIVED — see the write below.
    const userMessageAt = new Date();
    messages.push({ role: 'user', content: message.text });

    // Resolve AI model
    const resolved = await resolveModel(aliasModelId);
    if (!resolved) {
      await sendChannelMessage(channelType, message.chatId, 'Sorry, no AI models are available right now.', {
        replyToId: message.replyToId,
        threadId: message.threadId,
      });
      return;
    }

    const model = getAIModel(resolved, 'agent_run');

    // Generate AI response
    const systemPrompt = await getChannelSystemPrompt(channelType);
    const startTime = Date.now();
    const result = await generateText({
      model,
      system: systemPrompt,
      messages: messages.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      temperature: 0.7,
      maxOutputTokens: 2048,
    });

    const latencyMs = Date.now() - startTime;
    const fullResponse = result.text;

    // Finalize credits based on actual token usage
    const tokenUsage: CreditUsage = {
      promptTokens: result.usage?.inputTokens || 0,
      completionTokens: result.usage?.outputTokens || 0,
      totalTokens: (result.usage?.inputTokens || 0) + (result.usage?.outputTokens || 0),
    };

    try {
      await finalizeCredits(creditReservation, tokenUsage, aliasModelId);
      // Only once the charge returned. A finalize that threw leaves the
      // reservation unsettled, and therefore refunded by the `finally`.
      creditsSettled = true;
    } catch (error: unknown) {
      log.webhook.error({ err: error, channelType }, 'Error finalizing credits');
    }

    // Send response back via outbound adapter
    if (fullResponse) {
      await sendChannelMessage(channelType, message.chatId, fullResponse, {
        replyToId: message.replyToId,
        threadId: message.threadId,
      });
    }

    // Report model usage for health tracking
    await reportModelUsage(
      resolved.keyConfig.keyId,
      resolved.provider,
      resolved.modelId,
      true,
      latencyMs
    );

    // Save conversation metadata + append messages
    if (fullResponse) {
      await upsertConversation(db, {
        oxyUserId: botUser.oxyUserId,
        conversationId,
        lastMessage: fullResponse.slice(0, 100),
        titleOnInsert: message.text.slice(0, 50),
        source: channelType,
      });

      /**
       * The two turns carry the times they actually happened — the user's when
       * the update arrived, the assistant's now — rather than one `new Date()`
       * for both.
       *
       * These rows carry no `seq` (the append-ordering column), so `created_at`
       * IS the order they are read back in, and two identical timestamps leave
       * that order undefined on Postgres where Mongo's natural order settled it.
       * The values are not invented to break a tie: they are when each message
       * exists, and a model call sits between them.
       */
      await insertMessages(db, [
        { conversationId, oxyUserId: botUser.oxyUserId, role: 'user', content: message.text, createdAt: userMessageAt },
        { conversationId, oxyUserId: botUser.oxyUserId, role: 'assistant', content: fullResponse, createdAt: new Date() },
      ]);
    }
  } catch (error: unknown) {
    log.webhook.error({ err: error, channelType }, 'Chat processing error');
    try {
      await sendChannelMessage(channelType, message.chatId, 'Sorry, an error occurred. Please try again.', {
        replyToId: message.replyToId,
        threadId: message.threadId,
      });
    } catch { /* ignore send errors */ }
  } finally {
    // The one place this handler's reservation is released.
    if (creditReservation && !creditsSettled) {
      await safeRefund(creditReservation, 'inbound message ended without charging');
    }
  }
}

/**
 * NEW per-bot inbound path. Runs ONLY when an inbound update matched a user-registered
 * bot by its per-bot webhook secret (the secret match IS the verification). Uses the
 * bound Agent's configuration (system prompt + allowed models) and the bot OWNER's real
 * tool pipeline, bills the owner, and replies with the bot's OWN token. Conversation
 * continuity is tracked per Telegram end-user (the BotUser row), while Conversation and
 * Message docs are owned by the bot owner. The existing global-bot path is untouched.
 *
 * Exported for the reason {@link processChannelMessage} is: the route acks and
 * drops the promise, so nothing downstream of it is observable from the route.
 */
export async function processAgentBotMessage(
  bot: InboundUserBotRow,
  botUser: BotUserRow,
  message: ChannelInboundMessage,
  channelType: ChannelId,
): Promise<void> {
  const db = getDb();
  const ownerUserId = bot.userId ?? undefined;
  const outboundOpts = {
    replyToId: message.replyToId,
    threadId: message.threadId,
    // `undefined`, not `null`: the channel plugin falls back to the env token on
    // an absent one, and `null` is not a value its context type accepts.
    botToken: bot.botToken ?? undefined,
  };

  // Out here for the reason `processChannelMessage` states: this handler's exits
  // are just as numerous and the owner is the one who pays for a forgotten one.
  let creditReservation: CreditReservation | null = null;
  let creditsSettled = false;

  try {
    // Defensive: user-owned bots always carry an owner.
    if (!ownerUserId) return;

    // Bill the bot owner (not the Telegram end-user).
    await getOrCreateUserCredits(ownerUserId);
    creditReservation = await reserveCredits(ownerUserId);
    if (!creditReservation) {
      const appUrl = process.env.APP_URL || process.env.WEB_URL || 'https://alia.onl';
      await sendChannelMessage(
        channelType,
        message.chatId,
        `This assistant is temporarily unavailable (its owner is out of credits). More at ${appUrl}.`,
        outboundOpts,
      );
      return;
    }

    // Per-end-user conversation id lives on the BotUser row.
    let conversationId = botUser.conversationId;
    if (!conversationId) {
      conversationId = crypto.randomUUID();
      await setBotUserConversation(db, botUser.id, conversationId);
    }

    // Load recent history (owned by the bot owner, keyed by conversation id).
    let messages: Array<{ role: string; content: string }> = [];
    try {
      messages = [...await listRecentTurns(db, ownerUserId, conversationId, 20)];
    } catch (error: unknown) {
      log.webhook.error({ err: error, channelType }, 'Failed to load agent-bot conversation history');
    }

    // Stamped when it ARRIVED, for the reason the write below gives.
    const userMessageAt = new Date();
    messages.push({ role: 'user', content: message.text });

    // Resolve the bound agent's configuration (prompt + preferred model), with
    // its Oxy identity attached — the assembler takes the agent as an input and
    // the prompt below names it.
    const found = bot.agentId ? await findAgentById(getDb(), bot.agentId) : null;
    const agent = found === null ? null : await attachAgentIdentity(found);

    const aliasModelId = agent?.allowedModels[0] || getDefaultAliaModel();
    const resolved = await resolveModel(aliasModelId);
    if (!resolved) {
      await sendChannelMessage(channelType, message.chatId, 'Sorry, no AI models are available right now.', outboundOpts);
      return;
    }
    const model = getAIModel(resolved, 'agent_run');

    const systemPrompt = agent?.systemPrompt || (await getChannelSystemPrompt(channelType));

    /**
     * The bot owner's REAL tool set, through the ONE assembler.
     *
     * It used to be `buildChatTools`, which was the only path with `canvas` and
     * the trigger tools and the only path WITHOUT Oxy services — so an agent
     * answering here could not reach a single first-party Oxy service. It can
     * now, on the same assembly every other surface uses.
     */
    const { tools } = await ToolPipeline.forUser({
      userId: ownerUserId,
      // A bot turn has no browser session and no bearer of its own: it acts for
      // the OWNER, on their credits, through the token-less server paths.
      isDirectSession: false,
      // No bearer, but it answers FOR the bot owner and on their credits.
      actsForPerson: true,
      agentMode: false,
      toolsEnabled: true,
      webSearch: true,
      isLocalRuntime: false,
      agent,
    });

    const startTime = Date.now();
    const result = await generateText({
      model,
      system: systemPrompt,
      messages: messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      tools,
      temperature: 0.7,
      maxOutputTokens: 2048,
      stopWhen: stepCountIs(5),
    });

    const latencyMs = Date.now() - startTime;
    const fullResponse = result.text;

    const tokenUsage: CreditUsage = {
      promptTokens: result.usage?.inputTokens || 0,
      completionTokens: result.usage?.outputTokens || 0,
      totalTokens: (result.usage?.inputTokens || 0) + (result.usage?.outputTokens || 0),
    };
    try {
      await finalizeCredits(creditReservation, tokenUsage, aliasModelId);
      creditsSettled = true;
    } catch (error: unknown) {
      log.webhook.error({ err: error, channelType }, 'Error finalizing agent-bot credits');
    }

    if (fullResponse) {
      await sendChannelMessage(channelType, message.chatId, fullResponse, outboundOpts);
    }

    await reportModelUsage(resolved.keyConfig.keyId, resolved.provider, resolved.modelId, true, latencyMs);

    if (fullResponse) {
      await upsertConversation(db, {
        oxyUserId: ownerUserId,
        conversationId,
        lastMessage: fullResponse.slice(0, 100),
        titleOnInsert: message.text.slice(0, 50),
        source: channelType,
      });

      // Distinct timestamps, for the reason the system-bot path spells out.
      await insertMessages(db, [
        { conversationId, oxyUserId: ownerUserId, role: 'user', content: message.text, createdAt: userMessageAt },
        { conversationId, oxyUserId: ownerUserId, role: 'assistant', content: fullResponse, createdAt: new Date() },
      ]);
    }
  } catch (error: unknown) {
    log.webhook.error({ err: error, channelType }, 'Agent-bot processing error');
    try {
      await sendChannelMessage(channelType, message.chatId, 'Sorry, an error occurred. Please try again.', outboundOpts);
    } catch { /* ignore send errors */ }
  } finally {
    // The one place this handler's reservation is released.
    if (creditReservation && !creditsSettled) {
      await safeRefund(creditReservation, 'inbound agent-bot message ended without charging');
    }
  }
}

const router = express.Router();

// WhatsApp GET verification (hub.challenge)
router.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'] as string;
  const token = req.query['hub.verify_token'] as string;
  const challenge = req.query['hub.challenge'] as string;

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === 'subscribe' && verifyToken && verifySecret(token, verifyToken)) {
    log.webhook.info('WhatsApp verification successful');
    res.status(200).send(challenge);
  } else {
    log.webhook.warn('WhatsApp verification failed');
    res.sendStatus(403);
  }
});

// Unified webhook handler for all channels
router.post('/:type', async (req, res) => {
  const channelType = req.params.type as ChannelId;

  const channel = getChannel(channelType);
  if (!channel) {
    log.webhook.warn({ channelType }, 'Unknown channel type');
    return res.sendStatus(404);
  }

  if (!channel.webhook) {
    log.webhook.warn({ channelType }, 'Channel has no webhook adapter');
    return res.sendStatus(404);
  }

  // ── NEW: per-bot inbound routing (user-registered bots) ─────────────────────
  // A user-registered bot echoes ITS OWN webhook secret in this header. When it
  // matches an active user-owned bot, the update belongs to that bot and the secret
  // match IS the signature verification, so we handle it here with the bound agent +
  // owner's tools + the bot's own token, then return. When nothing matches (header
  // absent, or it carries the global bot's secret), we fall straight through to the
  // UNCHANGED global-bot code path below.
  const perBotSecret = req.headers['x-telegram-bot-api-secret-token'] as string | undefined;
  if (perBotSecret) {
    try {
      // The BY-VALUE lookup on `bots.webhook_secret`, which is why that column
      // is plaintext and indexed rather than `encryptedText`: a randomized IV
      // would make this match nothing and every inbound update would answer 200
      // having done nothing.
      const userBot = await findActiveUserBotByWebhookSecret(
        getDb(),
        perBotSecret,
        channelType,
      );

      if (userBot && userBot.userId) {
        const message = channel.webhook.parseMessage(req.body);
        if (!message) {
          return res.sendStatus(200);
        }

        // Scope dedup by the receiving bot so the same Telegram user texting two
        // different bots the same thing is not collapsed to one.
        if (isDuplicate(channelType, message, userBot.id)) {
          log.webhook.info({ channelType, platformUserId: message.platformUserId }, 'Duplicate per-bot message skipped');
          return res.sendStatus(200);
        }

        // Drop (silently, no credit spend) when a single sender floods the bot,
        // so a stranger can't rapidly burn the owner's credits.
        if (isBotUserRateLimited(userBot.id, message.platformUserId)) {
          log.webhook.info({ channelType, platformUserId: message.platformUserId }, 'Per-bot message rate-limited');
          return res.sendStatus(200);
        }

        // One statement instead of read-then-branch: two messages from the same
        // person arriving together raced the source's insert.
        const botUser = await upsertBotUser(getDb(), {
          botId: userBot.id,
          platform: channelType,
          platformUserId: message.platformUserId,
          chatId: message.chatId,
          username: message.username,
          displayName: message.displayName,
        });

        // Ack immediately (Telegram retries on non-2xx), then process asynchronously.
        res.sendStatus(200);
        processAgentBotMessage(userBot, botUser, message, channelType).catch((error: unknown) => {
          log.webhook.error({ err: error, channelType }, 'Async per-bot processing error');
        });
        return;
      }
      // No user-owned bot matched — fall through to the global-bot path unchanged.
    } catch (error: unknown) {
      // A DB error here must not leave the request hanging (Telegram would retry
      // forever). Respond 500 so the platform retries cleanly; never fall through
      // to the global path on an error, since we don't know if this was a user bot.
      log.webhook.error({ err: error, channelType }, 'Per-bot inbound routing error');
      return res.sendStatus(500);
    }
  }

  // Slack URL verification challenge
  if (channelType === 'slack' && req.body?.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }

  // Verify webhook signature
  if (!channel.webhook.verifySignature(req)) {
    log.webhook.warn({ channelType }, 'Signature verification failed');
    return res.sendStatus(401);
  }

  // Discord interaction ping
  if (channelType === 'discord' && req.body?.type === 1) {
    return res.json({ type: 1 });
  }

  // Parse the inbound message
  const message = channel.webhook.parseMessage(req.body);
  if (!message) {
    return res.sendStatus(200);
  }

  // Deduplicate: skip if this message was already processed recently
  if (isDuplicate(channelType, message)) {
    log.webhook.info({ channelType, platformUserId: message.platformUserId }, 'Duplicate message skipped');
    return res.sendStatus(200);
  }

  // The message TEXT is a user prompt and never goes to the log; its length is
  // what an operator actually needs to tell an empty webhook from a real one.
  // `username` is out for the same reason `text` is — the platform user id is
  // the opaque handle every other line in this file correlates on.
  log.webhook.info({
    channelType,
    from: message.platformUserId,
    chatId: message.chatId,
    textLength: message.text.length,
  }, 'Inbound message');

  try {
    // Find the system bot for this channel type. Scoped to `userId: { $exists: false }`
    // so a legitimate global-bot update never binds to a user-registered bot now that
    // both live in the same collection — this selects the exact same (system) document
    // the query returned before per-bot support existed.
    const bot: BotRow | null = await findSystemBot(getDb(), channelType, { activeOnly: true });
    if (!bot) {
      log.webhook.warn({ channelType }, 'No active bot found for channel type');
      return res.sendStatus(200);
    }

    // Find or create bot user, in one statement.
    const botUser = await upsertBotUser(getDb(), {
      botId: bot.id,
      platform: channelType,
      platformUserId: message.platformUserId,
      chatId: message.chatId,
      username: message.username,
      displayName: message.displayName,
    });

    // Respond immediately to webhook (Slack has 3s timeout)
    res.sendStatus(200);

    // Process message asynchronously
    processChannelMessage(channelType, botUser, message).catch((error: unknown) => {
      log.webhook.error({ err: error, channelType }, 'Async processing error');
    });
  } catch (error: unknown) {
    log.webhook.error({ err: error, channelType }, 'Error processing webhook message');
    res.sendStatus(200);
  }
});

export default router;
