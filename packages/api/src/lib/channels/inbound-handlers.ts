import { reserveBackgroundProductCredits } from '../product-credit-access';
import crypto from 'node:crypto';
import { generateText } from 'ai';
import { stepBudget } from '../tool-budget.js';
import { generateAnswered } from '../chat/tool-synthesis.js';
import { resolveStoredModel, getAIModel, type ResolvedModel } from '../chat-core.js';
import { sendChannelMessage } from '../channels/outbound.js';
import { ToolPipeline } from '../tool-pipeline.js';
import { agentPromptName, attachAgentIdentity } from '../agent-identity.js';
import { agentRemitPrompt } from '../agent/archetype-prompts.js';
import { agentSpacePrompt } from '../agent/space-prompt.js';
import { buildIdentityGuard } from '../identity-guard.js';
import { loadPrompt } from '../prompt-loader.js';
import { getDb } from '../../db/index.js';
import {
  setBotUserAuthToken,
  setBotUserConversation,
  type BotUserRow,
  type InboundUserBotRow,
} from '../../db/integrations/botRepository.js';
import { findAgentById } from '../../db/agents/agentRepository.js';
import { upsertConversation } from '../../db/chat/conversationRepository.js';
import { insertMessages, listRecentTurns } from '../../db/chat/messageRepository.js';
import { getOrCreateUserCredits } from '../user-credits-helpers.js';
import {
  finalizeCredits,
  safeRefund,
  type CreditReservation,
  type CreditUsage,
} from '../credits-manager.js';
import { reserveAgentTurn } from '../agent/turn-funding.js';
import type { ChannelId, ChannelInboundMessage } from '../channels/types.js';
import { log } from '../logger.js';
import { servedModelId, servedReferenceOf } from '../models/power-levels.js';

/**
 * How to answer on a channel with no prompt file of its own. It names nobody:
 * both callers prepend `buildIdentityGuard`, which is the one owner of who the
 * assistant is, and a second name claim here would contradict the guard on an
 * AGENT's bot instead of merely repeating it.
 */
const DEFAULT_CHANNEL_PROMPT = `Be concise and direct — this is a messaging channel.

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
  message: ChannelInboundMessage,
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
        { replyToId: message.replyToId, threadId: message.threadId },
      );
      return;
    }

    const userId = botUser.oxyUserId.toString();
    /**
     * The chat's stored model preference — a `publisher/model` written by
     * `packages/integrations`' `/model` command, shared through
     * `bot_users.preferred_model` — or the person's default when it is unset or
     * the catalogue no longer offers it (ADR 0012).
     */
    let resolved: ResolvedModel;
    try {
      resolved = await resolveStoredModel(botUser.preferredModel);
    } catch (error: unknown) {
      log.channels.warn({ err: error }, 'No model available for a bot message');
      await sendChannelMessage(
        channelType,
        message.chatId,
        'Sorry, no AI models are available right now.',
        {
          replyToId: message.replyToId,
          threadId: message.threadId,
        },
      );
      return;
    }
    const modelId = resolved.modelId;

    // Reserve credits before processing
    await getOrCreateUserCredits(userId);

    creditReservation = await reserveBackgroundProductCredits(userId);
    if (!creditReservation) {
      const appUrl = process.env.APP_URL || process.env.WEB_URL || 'https://alia.onl';
      await sendChannelMessage(
        channelType,
        message.chatId,
        `You've run out of credits. Add more at ${appUrl} to continue using Alia.`,
        { replyToId: message.replyToId, threadId: message.threadId },
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
      messages = [...(await listRecentTurns(db, botUser.oxyUserId, conversationId, 20))];
    } catch (error: unknown) {
      log.webhook.error({ err: error, channelType }, 'Failed to load conversation history');
    }

    // Add the new user message, stamped when it ARRIVED — see the write below.
    const userMessageAt = new Date();
    messages.push({ role: 'user', content: message.text });

    const model = getAIModel(resolved, 'agent_run');

    /**
     * The SHARED system bot, and the seventh composition path.
     *
     * It had no identity guard: `prompts/alia-telegram.md` opened "You are
     * Alia, an AI assistant by Oxy. Never reveal underlying AI models or
     * providers", and that markdown line was the whole of the boundary on a
     * surface strangers DM. Now that the prompt files describe style and name
     * nobody, the line is gone and the guard is what stands here — which is
     * also a stronger rule than the one it replaces.
     *
     * No agent: this bot is Alia itself. `findSystemBot` is what selected it
     * upstream — the row with no owner — and an agent's own bot is
     * `processAgentBotMessage` below, which passes that agent's name.
     */
    const systemPrompt = `${buildIdentityGuard()}\n\n---\n\n${await getChannelSystemPrompt(channelType)}`;
    const result = await generateText({
      model,
      system: systemPrompt,
      messages: messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      temperature: 0.7,
      maxOutputTokens: 2048,
    });

    const fullResponse = result.text;

    // Finalize credits based on actual token usage
    const tokenUsage: CreditUsage = {
      promptTokens: result.usage?.inputTokens || 0,
      completionTokens: result.usage?.outputTokens || 0,
      totalTokens: (result.usage?.inputTokens || 0) + (result.usage?.outputTokens || 0),
    };

    try {
      await finalizeCredits(
        creditReservation,
        tokenUsage,
        servedModelId(modelId, servedReferenceOf(result)),
      );
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
       * that order undefined.
       * The values are not invented to break a tie: they are when each message
       * exists, and a model call sits between them.
       */
      await insertMessages(db, [
        {
          conversationId,
          oxyUserId: botUser.oxyUserId,
          role: 'user',
          content: message.text,
          createdAt: userMessageAt,
        },
        {
          conversationId,
          oxyUserId: botUser.oxyUserId,
          role: 'assistant',
          content: fullResponse,
          createdAt: new Date(),
        },
      ]);
    }
  } catch (error: unknown) {
    log.webhook.error({ err: error, channelType }, 'Chat processing error');
    try {
      await sendChannelMessage(
        channelType,
        message.chatId,
        'Sorry, an error occurred. Please try again.',
        {
          replyToId: message.replyToId,
          threadId: message.threadId,
        },
      );
    } catch {
      /* ignore send errors */
    }
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
 * tool pipeline, funds the turn through {@link reserveAgentTurn} — the agent's own
 * balance first, then the owner's if the owner consented — and replies with the bot's
 * OWN token. Conversation
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

    // Resolve the bound agent's configuration (prompt + preferred model), with
    // its Oxy identity attached — the assembler takes the agent as an input and
    // the prompt below names it.
    //
    // BEFORE the reservation, because WHO pays depends on it: the agent's own
    // account is the first payer. A bot with no agent, or an agent with no
    // model, has nothing to run, so it never reserves at all.
    const found = bot.agentId ? await findAgentById(getDb(), bot.agentId) : null;
    const agent = found === null ? null : await attachAgentIdentity(found);

    const resolved =
      agent === null ? null : await resolveStoredModel(agent.modelId).catch(() => null);
    if (agent === null || resolved === null) {
      await sendChannelMessage(
        channelType,
        message.chatId,
        'Sorry, no AI models are available right now.',
        outboundOpts,
      );
      return;
    }

    /**
     * Who pays: the agent, else its owner if the owner consented, else nobody.
     *
     * This is the case `lib/agent/turn-funding.ts` was written for — the agent
     * answering a stranger on its own bot, a turn nobody present chose to pay
     * for. It used to be billed to the owner unconditionally.
     *
     * The OWNER is provisioned (a person is entitled to the free allowance);
     * the AGENT's account is deliberately not — see `turn-funding.ts` on the
     * free-credit farm. An agent with no balance row simply cannot pay and
     * falls through to the owner, debiting nothing on the way.
     *
     * `ownerPaysAgentTurns` is the owner's consent, stored on the bot row the
     * owner alone can write. The reservation carries exactly one payer, and
     * `finalizeCredits` / `safeRefund` below settle against that one — so the
     * rest of this handler needs no idea which account it was.
     */
    await getOrCreateUserCredits(ownerUserId);
    const funding = await reserveAgentTurn({
      agentAccountId: agent.oxyAccountId,
      ownerUserId,
      ownerFallbackAllowed: bot.ownerPaysAgentTurns,
    });
    if (!funding.ok) {
      const appUrl = process.env.APP_URL || process.env.WEB_URL || 'https://alia.onl';
      // Two different messages, for the reason the refusal type gives: one is a
      // permission the owner can GRANT, the other credit somebody must BUY.
      const text =
        funding.reason === 'owner_fallback_not_authorised'
          ? `This assistant is not available yet (its owner has not allowed it to use their credits). More at ${appUrl}.`
          : `This assistant is temporarily unavailable (its owner is out of credits). More at ${appUrl}.`;
      await sendChannelMessage(channelType, message.chatId, text, outboundOpts);
      return;
    }
    creditReservation = funding.reservation;

    // Per-end-user conversation id lives on the BotUser row.
    let conversationId = botUser.conversationId;
    if (!conversationId) {
      conversationId = crypto.randomUUID();
      await setBotUserConversation(db, botUser.id, conversationId);
    }

    // Load recent history (owned by the bot owner, keyed by conversation id).
    let messages: Array<{ role: string; content: string }> = [];
    try {
      messages = [...(await listRecentTurns(db, ownerUserId, conversationId, 20))];
    } catch (error: unknown) {
      log.webhook.error(
        { err: error, channelType },
        'Failed to load agent-bot conversation history',
      );
    }

    // Stamped when it ARRIVED, for the reason the write below gives.
    const userMessageAt = new Date();
    messages.push({ role: 'user', content: message.text });

    const modelId = resolved.modelId;
    const model = getAIModel(resolved, 'agent_run');

    /**
     * The identity guard, which this path did not have either.
     *
     * An agent's own Telegram bot is the surface where its name matters most —
     * a stranger is talking to it by name — and it was the surface with no
     * guard at all, so a route detail could leak straight into a DM.
     *
     * The prompt below it is {@link agentRemitPrompt} rather than
     * `agent.systemPrompt`, which fell through to the generic Alia channel
     * prompt whenever the owner had not written one: the guard said "You are
     * Claudio" and the section under it described Alia's Telegram manners and
     * nothing about Claudio. The remit is what the guard's remit rule points
     * at, so the two have to be the same thing on every surface.
     */
    const systemPrompt = `${buildIdentityGuard({ agentName: agentPromptName(agent) })}\n\n---\n\n${agentRemitPrompt(agent)}${await agentSpacePrompt(agent)}`;

    /**
     * The bot owner's REAL tool set, through the ONE assembler.
     *
     * It used to be `buildChatTools`, which was the only path with `canvas` and
     * the trigger tools and the only path WITHOUT Oxy services — so an agent
     * answering here could not reach a single first-party Oxy service. It can
     * now, on the same assembly every other surface uses.
     */
    /**
     * Anyone can write to an agent's bot. Only its owner, recognised by a
     * linked Oxy account, gets the owner's personal tools (memory, triggers,
     * connectors, Oxy apps); a stranger talks to the agent itself.
     */
    const speakerAccountId = botUser.isLinked ? (botUser.oxyUserId ?? null) : null;
    const speakerIsOwner = speakerAccountId === ownerUserId;
    const {
      tools,
      routing: toolRouting,
      appCatalogPrompt,
    } = await ToolPipeline.forUser({
      userId: ownerUserId,
      // A bot turn has no browser session and no bearer of its own: it runs on
      // the OWNER's credits, through the token-less server paths.
      isDirectSession: false,
      actsForPerson: speakerIsOwner,
      requesterAccountId: speakerAccountId,
      inputLimits: resolved.catalogue,
      toolsEnabled: true,
      webSearch: true,
      isLocalRuntime: false,
      agent,
    });

    const answered = await generateAnswered({
      model,
      system: systemPrompt + appCatalogPrompt,
      messages: messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      tools,
      // Bounds each request to the per-request tool budget (`lib/tool-budget.ts`).
      ...toolRouting,
      temperature: 0.7,
      maxOutputTokens: 2048,
      stopWhen: stepBudget(5),
    });

    const fullResponse = answered.text;

    // Every step of the loop and the answer pass, not the last call alone.
    const tokenUsage: CreditUsage = {
      promptTokens: answered.usage.inputTokens,
      completionTokens: answered.usage.outputTokens,
      totalTokens: answered.usage.totalTokens,
    };
    try {
      await finalizeCredits(
        creditReservation,
        tokenUsage,
        servedModelId(modelId, servedReferenceOf(answered.last)),
      );
      creditsSettled = true;
    } catch (error: unknown) {
      log.webhook.error({ err: error, channelType }, 'Error finalizing agent-bot credits');
    }

    if (fullResponse) {
      await sendChannelMessage(channelType, message.chatId, fullResponse, outboundOpts);
    }

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
        {
          conversationId,
          oxyUserId: ownerUserId,
          role: 'user',
          content: message.text,
          createdAt: userMessageAt,
        },
        {
          conversationId,
          oxyUserId: ownerUserId,
          role: 'assistant',
          content: fullResponse,
          createdAt: new Date(),
        },
      ]);
    }
  } catch (error: unknown) {
    log.webhook.error({ err: error, channelType }, 'Agent-bot processing error');
    try {
      await sendChannelMessage(
        channelType,
        message.chatId,
        'Sorry, an error occurred. Please try again.',
        outboundOpts,
      );
    } catch {
      /* ignore send errors */
    }
  } finally {
    // The one place this handler's reservation is released.
    if (creditReservation && !creditsSettled) {
      await safeRefund(creditReservation, 'inbound agent-bot message ended without charging');
    }
  }
}
