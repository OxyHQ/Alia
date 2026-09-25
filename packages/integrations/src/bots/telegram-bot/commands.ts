/**
 * Telegram Bot command handlers — adapted from apps/telegram-bot/src/handlers/.
 *
 * Uses the shared APIClient (channels API) instead of the legacy /telegram/ routes.
 */

import { Context, Markup } from 'telegraf';
import { randomUUID } from 'node:crypto';
import { APIClient } from '../../shared/api-client';
import {
  currentModelLabel,
  defaultLabel,
  findModel,
  fitLines,
  isFeatured,
  modelsForListing,
  resolveModelCommand,
  resolveRequestModel,
  type Catalogue,
  type CatalogueModel,
} from '../../shared/catalogue';
import { createLogger } from '../../shared/logger';

const apiClient = new APIClient('telegram', process.env.TELEGRAM_BOT_SECRET || '');
const logger = createLogger('TelegramBot');

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/** Ensure the bot user exists, then generate an auth-request link. */
export async function sendAuthRequest(ctx: Context): Promise<boolean> {
  const telegramId = ctx.from?.id.toString();
  const chatId = ctx.chat?.id.toString();
  if (!telegramId || !chatId) {
    await ctx.reply('Unable to identify you. Please try again.');
    return false;
  }

  try {
    // Ensure bot user exists
    let botUser = await apiClient.getBotUser(telegramId);
    if (!botUser) {
      botUser = await apiClient.createOrUpdateBotUser({
        platformUserId: telegramId,
        chatId,
        displayName: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || undefined,
      });
    }

    // Already authenticated?
    if (botUser.isLinked) {
      return true;
    }

    // Request auth token
    const { authUrl } = await apiClient.requestAuthToken(telegramId);

    await ctx.reply(
      `👋 <b>Welcome to Alia AI!</b>\n\n` +
      `To get started, please authenticate your account.\n\n` +
      `Click the button below to sign in through the Alia app.\n\n` +
      `<i>⏱ This link expires in 15 minutes</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.url('🔐 Sign In to Alia', authUrl)],
        ]),
      },
    );

    return false;
  } catch (error) {
    logger.error('Auth request error:', error);
    await ctx.reply('Sorry, an error occurred. Please try again later.');
    return false;
  }
}

// ---------------------------------------------------------------------------
// /start
// ---------------------------------------------------------------------------
export async function handleStart(ctx: Context) {
  const telegramId = ctx.from?.id.toString();
  const chatId = ctx.chat?.id.toString();
  if (!telegramId || !chatId) {
    await ctx.reply('Unable to identify you. Please try again.');
    return;
  }

  try {
    // Ensure bot user exists
    let botUser = await apiClient.getBotUser(telegramId);
    if (!botUser) {
      botUser = await apiClient.createOrUpdateBotUser({
        platformUserId: telegramId,
        chatId,
        displayName: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || undefined,
      });
    }

    // Already linked & authenticated
    if (botUser.isLinked) {
      const displayName = botUser.displayName || ctx.from?.first_name || 'there';
      await ctx.reply(
        `👋 <b>Welcome back, ${displayName}!</b>\n\n` +
        `✅ Your Telegram is already linked to your Alia account.\n\n` +
        `You're all set! Just send me a message to start chatting. 💬`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🆕 New Chat', 'new')],
            [Markup.button.callback('📊 Account Status', 'status')],
            [Markup.button.callback('🚪 Disconnect', 'logout')],
          ]),
        },
      );
      return;
    }

    // Not linked — offer sign-in
    const { authUrl } = await apiClient.requestAuthToken(telegramId);
    await ctx.reply(
      `👋 <b>Welcome to Alia AI!</b>\n\n` +
      `To use Alia on Telegram, you need to link your Telegram to your existing Alia account.\n\n` +
      `Don't have an Alia account yet? Create one at <b>alia.onl</b> first, then come back here to link it!\n\n` +
      `<i>⏱ This link expires in 15 minutes</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.url('🔗 Link to Existing Account', authUrl)],
          [Markup.button.url('🌐 Create Account at alia.onl', 'https://alia.onl')],
        ]),
      },
    );
  } catch (error) {
    logger.error('Start command error:', error);
    await ctx.reply('Sorry, an error occurred. Please try again later.');
  }
}

// ---------------------------------------------------------------------------
// /logout
// ---------------------------------------------------------------------------
export async function handleLogout(ctx: Context) {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) {
    await ctx.reply('Unable to identify you. Please try again.');
    return;
  }

  try {
    const botUser = await apiClient.getBotUser(telegramId);
    if (!botUser || !botUser.isLinked) {
      await ctx.reply('You are not currently authenticated.');
      return;
    }

    await apiClient.logoutUser(telegramId);

    await ctx.reply(
      '👋 <b>Logged Out Successfully</b>\n\n' +
      'Your Telegram account has been disconnected from Alia.\n\n' +
      'Use /start whenever you want to sign in again.',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔐 Sign In Again', 'start')],
        ]),
      },
    );
  } catch (error) {
    logger.error('Logout error:', error);
    await ctx.reply('Sorry, an error occurred. Please try again later.');
  }
}

// ---------------------------------------------------------------------------
// /status
// ---------------------------------------------------------------------------
export async function handleStatus(ctx: Context) {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) {
    await ctx.reply('Unable to identify you. Please try again.');
    return;
  }

  try {
    const botUser = await apiClient.getBotUser(telegramId);
    if (!botUser || !botUser.isLinked) {
      await sendAuthRequest(ctx);
      return;
    }

    const displayName = botUser.displayName || botUser.username || 'Not set';

    // The model row is omitted only when the catalogue could not be read.
    const catalogue = await apiClient.fetchCatalogue();
    const modelLabel = catalogue === null ? null : currentModelLabel(botUser.preferredModel, catalogue);

    await ctx.reply(
      `📊 <b>Account Status</b>\n\n` +
      `👤 <b>Name:</b> ${displayName}\n` +
      `✅ <b>Status:</b> Connected\n` +
      (modelLabel === null ? '' : `🤖 <b>Model:</b> ${escapeHtml(modelLabel)}\n`) +
      `🔗 <b>Linked:</b> ${botUser.linkedAt ? new Date(botUser.linkedAt).toLocaleDateString() : 'N/A'}`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Refresh', 'status')],
          [Markup.button.callback('« Back', 'start')],
        ]),
      },
    );
  } catch (error) {
    logger.error('Status error:', error);
    await ctx.reply('Sorry, an error occurred. Please try again later.');
  }
}

// ---------------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------------
export async function handleHelp(ctx: Context) {
  const helpMessage = `
🤖 <b>Alia AI Bot - Help Guide</b>

<b>📌 Getting Started:</b>
• /start - Authenticate your account
• /status - Check account & credits
• /logout - Disconnect your account

<b>💬 Chatting:</b>
• Just send me any message to chat!
• /new - Start a fresh conversation
• /history - View past conversations
• /model - Choose the model (/model &lt;text&gt; searches)

<b>❓ Need Help?</b>
• /help - Show this help message

<b>🎯 How It Works:</b>
1️⃣ Send /start to begin
2️⃣ Click the sign-in button
3️⃣ Authenticate in the Alia app
4️⃣ Return and start chatting!

<b>💡 Example:</b>
<i>You:</i> Hello, who are you?
<i>Alia:</i> I'm Alia, your AI assistant! How can I help you today?
`;

  await ctx.reply(helpMessage, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('🚀 Get Started', 'start'),
        Markup.button.callback('📊 My Status', 'status'),
      ],
      [Markup.button.url('🌐 Visit Alia App', 'https://alia.onl')],
    ]),
  });
}

// ---------------------------------------------------------------------------
// /model + model selection callback
// ---------------------------------------------------------------------------
/** Telegram's message text limit. */
const TELEGRAM_MAX_CHARS = 4096;
/** Telegram's `callback_data` limit, in bytes. */
const CALLBACK_DATA_MAX_BYTES = 64;
/** At most this many models in one listing, and this many as buttons. */
const MAX_LISTED = 30;
const MAX_BUTTONS = 8;

const MODEL_CALLBACK_PREFIX = 'model_';
/** The callback that clears the choice. Not a `publisher/model` id, so it can never collide with one. */
export const MODEL_RESET_CALLBACK = `${MODEL_CALLBACK_PREFIX}default`;

const SEARCH_HINT =
  '<i>Send /model &lt;text&gt; to search by name, publisher or id, or /model default to go back to the default.</i>';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function quoted(text: string): string {
  return escapeHtml(text.length > 80 ? `${text.slice(0, 79)}…` : text);
}

function modelLine(model: CatalogueModel, chosenId: string | undefined): string {
  const current = model.id === chosenId ? ' ✓' : '';
  return `• <b>${escapeHtml(model.name)}</b> — ${escapeHtml(model.publisher.name)} <code>${escapeHtml(model.id)}</code>${current}`;
}

/** A button for a model, or `null` when its id does not fit in `callback_data`. */
function modelButton(model: CatalogueModel): TelegramModelButton | null {
  const data = `${MODEL_CALLBACK_PREFIX}${model.id}`;
  if (Buffer.byteLength(data, 'utf8') > CALLBACK_DATA_MAX_BYTES) return null;
  return { label: model.name, data };
}

export interface TelegramModelButton {
  readonly label: string;
  readonly data: string;
}

/** What `/model` replies, or stores and then replies. */
export type TelegramModelPlan =
  | { readonly kind: 'reply'; readonly html: string; readonly buttons: readonly TelegramModelButton[] }
  | { readonly kind: 'store'; readonly model: string | null; readonly html: string };

/** A heading, the models and a footer within Telegram's 4096 characters, then "…and N more". */
function renderModelList(
  heading: string,
  models: readonly CatalogueModel[],
  chosenId: string | undefined,
  footer: string,
): string {
  const lines = models.map((model) => modelLine(model, chosenId));
  const shown = lines.slice(0, MAX_LISTED);
  const beyond = lines.length - shown.length;
  const more = (omitted: number) => `<i>…and ${omitted + beyond} more.</i>`;
  const budget = TELEGRAM_MAX_CHARS - heading.length - footer.length - 4;
  const body = beyond > 0
    ? fitLines([...shown, more(0)], budget, (omitted) => more(omitted - 1))
    : fitLines(shown, budget, more);
  return `${heading}\n${body}\n\n${footer}`;
}

function buttonsFor(models: readonly CatalogueModel[], withReset: boolean): TelegramModelButton[] {
  const buttons = models
    .map(modelButton)
    .filter((button): button is TelegramModelButton => button !== null)
    .slice(0, MAX_BUTTONS);
  return withReset ? [...buttons, { label: '↩️ Default', data: MODEL_RESET_CALLBACK }] : buttons;
}

/**
 * Decide what `/model [text]` does, without doing it. `null` catalogue means it
 * could not be read; nothing is stored then, because a model is only ever
 * chosen from what the catalogue lists.
 */
export function planTelegramModelCommand(
  catalogue: Catalogue | null,
  preferredModel: string | undefined,
  argument: string | null | undefined,
): TelegramModelPlan {
  if (catalogue === null) {
    return { kind: 'reply', html: '❌ Unable to load the available models. Please try again later.', buttons: [] };
  }
  const chosenId = resolveRequestModel(preferredModel, catalogue);
  const command = resolveModelCommand(argument, catalogue);
  switch (command.kind) {
    case 'list': {
      const current = `🤖 <b>Current model:</b> ${escapeHtml(currentModelLabel(preferredModel, catalogue))}`;
      const models = modelsForListing(catalogue);
      if (models.length === 0) {
        return { kind: 'reply', html: `${current}\n\nNo models are available right now.`, buttons: [] };
      }
      const featured = models.filter((model) => isFeatured(catalogue, model));
      return {
        kind: 'reply',
        html: renderModelList(
          `${current}\n\n<b>${featured.length > 0 ? 'Featured models' : 'Models'}:</b>`,
          models,
          chosenId,
          SEARCH_HINT,
        ),
        buttons: buttonsFor(featured.length > 0 ? featured : models, chosenId !== undefined),
      };
    }
    case 'reset':
      return {
        kind: 'store',
        model: null,
        html: `🤖 <b>Model updated</b>\n\nAlia will now use the <b>${escapeHtml(defaultLabel(catalogue))}</b> model.`,
      };
    case 'select':
      return {
        kind: 'store',
        model: command.model.id,
        html: `🤖 <b>Model updated</b>\n\nAlia will now answer with <b>${escapeHtml(command.model.name)}</b> ` +
          `(<code>${escapeHtml(command.model.id)}</code>).\n\nAll future conversations will use it.`,
      };
    case 'matches':
      return {
        kind: 'reply',
        html: renderModelList(
          `🔎 <b>${command.models.length} models match “${quoted(command.query)}”:</b>`,
          command.models,
          chosenId,
          '<i>Tap one, or send /model &lt;id&gt;.</i>',
        ),
        buttons: buttonsFor(command.models, false),
      };
    case 'none':
      return {
        kind: 'reply',
        html: `❌ No model matches “${quoted(command.query)}”.\n\n${SEARCH_HINT}`,
        buttons: [],
      };
  }
}

/** The text after `/model` (or `/model@SomeBot`), if the update is a text message. */
function commandArgument(ctx: Context): string {
  const message = ctx.message;
  if (message === undefined || !('text' in message)) return '';
  return message.text.replace(/^\/\S+\s*/, '');
}

function buttonRows(buttons: readonly TelegramModelButton[]) {
  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2).map((button) => Markup.button.callback(button.label, button.data)));
  }
  rows.push([Markup.button.callback('« Back', 'start')]);
  return rows;
}

export async function handleModel(ctx: Context) {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) {
    await ctx.reply('Unable to identify you. Please try again.');
    return;
  }

  try {
    const botUser = await apiClient.getBotUser(telegramId);
    if (!botUser || !botUser.isLinked) {
      await ctx.reply(
        '🔒 <b>Authentication Required</b>\n\n' +
        'Please sign in first to choose a model.',
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔐 Sign In', 'start')],
          ]),
        },
      );
      return;
    }

    const plan = planTelegramModelCommand(
      await apiClient.fetchCatalogue(),
      botUser.preferredModel,
      commandArgument(ctx),
    );
    if (plan.kind === 'store') {
      await apiClient.updateModel(telegramId, plan.model);
      await ctx.reply(plan.html, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('« Back to Menu', 'start')]]),
      });
      return;
    }
    await ctx.reply(plan.html, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...Markup.inlineKeyboard(buttonRows(plan.buttons)),
    });
  } catch (error) {
    logger.error('Model command error:', error);
    await ctx.reply('❌ Error loading your model settings. Please try again.');
  }
}

/**
 * A tapped model button. `data` is what follows `model_`: a model id this bot
 * rendered from the catalogue, or `default`. The id is checked against the
 * catalogue again, since the listing may have changed since it was rendered.
 */
export async function handleModelSelection(ctx: Context, data: string) {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) {
    await ctx.answerCbQuery('Unable to identify you');
    return;
  }

  try {
    const catalogue = await apiClient.fetchCatalogue();
    if (catalogue === null) {
      await ctx.reply('❌ Unable to load the available models. Please try again later.');
      return;
    }
    const reset = `${MODEL_CALLBACK_PREFIX}${data}` === MODEL_RESET_CALLBACK;
    const model = reset ? null : findModel(catalogue, data);
    if (!reset && model === null) {
      await ctx.reply('❌ That model is no longer available. Send /model to see the current list.');
      return;
    }

    await apiClient.updateModel(telegramId, model === null ? null : model.id);
    await ctx.reply(
      model === null
        ? `🤖 <b>Model updated</b>\n\nAlia will now use the <b>${escapeHtml(defaultLabel(catalogue))}</b> model.`
        : `🤖 <b>Model updated</b>\n\nAlia will now answer with <b>${escapeHtml(model.name)}</b> ` +
          `(<code>${escapeHtml(model.id)}</code>).\n\nAll future conversations will use it.`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('« Back to Menu', 'start')],
        ]),
      },
    );
  } catch (error) {
    logger.error('Model selection error:', error);
    await ctx.reply('❌ Error updating your model. Please try again.');
  }
}

// ---------------------------------------------------------------------------
// /new — start a new conversation
// ---------------------------------------------------------------------------
export async function handleNewConversation(ctx: Context) {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) {
    await ctx.reply('Unable to identify you. Please try again.');
    return;
  }

  try {
    const botUser = await apiClient.getBotUser(telegramId);
    if (!botUser || !botUser.isLinked) {
      await sendAuthRequest(ctx);
      return;
    }

    const newConversationId = randomUUID();
    await apiClient.updateConversation(telegramId, newConversationId);

    await ctx.reply(
      '✨ <b>New Conversation Started!</b>\n\n' +
      'Your previous conversation has been saved.\n' +
      'Send me any message to begin chatting in this new conversation.',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📚 View History', 'history')],
        ]),
      },
    );
  } catch (error) {
    logger.error('New conversation error:', error);
    await ctx.reply('Sorry, an error occurred. Please try again later.');
  }
}

// ---------------------------------------------------------------------------
// /history — view recent conversations
// ---------------------------------------------------------------------------
export async function handleHistory(ctx: Context) {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) {
    await ctx.reply('Unable to identify you. Please try again.');
    return;
  }

  try {
    const botUser = await apiClient.getBotUser(telegramId);
    if (!botUser || !botUser.isLinked || !botUser.oxyUserId) {
      await sendAuthRequest(ctx);
      return;
    }

    try {
      const conversations = await apiClient.getConversations(botUser.oxyUserId);
      if (!conversations || conversations.length === 0) {
        await ctx.reply(
          '📚 <b>No Conversations Yet</b>\n\n' +
          'Start chatting with me to create your first conversation!',
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('« Back', 'start')],
            ]),
          },
        );
        return;
      }

      let message = '📚 <b>Your Recent Conversations</b>\n\n';
      conversations.slice(0, 10).forEach((conv, index: number) => {
        const title = conv.title || 'Untitled';
        const date = new Date(conv.updatedAt || conv.createdAt || Date.now()).toLocaleDateString();
        const current = conv.conversationId === botUser.conversationId ? '▶️ ' : '  ';
        message += `${current}<b>${index + 1}.</b> ${title}\n   <i>${date}</i>\n\n`;
      });

      if (conversations.length > 10) {
        message += `\n<i>... and ${conversations.length - 10} more conversations</i>`;
      }

      await ctx.reply(message, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🆕 New Chat', 'new')],
          [Markup.button.callback('« Back', 'start')],
        ]),
      });
    } catch (error) {
      logger.error('Error fetching history:', error);
      await ctx.reply('❌ Unable to fetch conversation history.');
    }
  } catch (error) {
    logger.error('History error:', error);
    await ctx.reply('Sorry, an error occurred. Please try again later.');
  }
}
