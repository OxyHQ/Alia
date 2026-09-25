import { Message, Client, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { APIClient } from '../../shared/api-client';
import {
  currentModelLabel,
  defaultLabel,
  fitLines,
  isFeatured,
  modelsForListing,
  resolveModelCommand,
  resolveRequestModel,
  type Catalogue,
  type CatalogueModel,
} from '../../shared/catalogue';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../../shared/logger';

const logger = createLogger('Discord');

let apiClient: APIClient;

export function initCommands(client: APIClient) {
  apiClient = client;
}

/** Discord's message content limit. */
const DISCORD_MAX_CHARS = 2000;
/** At most this many models in one listing, however short their names. */
const MAX_LISTED = 25;

const SEARCH_HINT =
  '`/model <text>` searches by name, publisher or id; `/model default` goes back to the default.';
/** What a person typed, shortened to sit in a heading. */
function quoted(text: string): string {
  return `“${text.length > 80 ? `${text.slice(0, 79)}…` : text}”`;
}

const CATALOGUE_UNAVAILABLE = 'Unable to load the available models. Please try again later.';

function modelLine(model: CatalogueModel, chosenId: string | undefined): string {
  const current = model.id === chosenId ? ' ✓' : '';
  return `• **${model.name}** — ${model.publisher.name} \`${model.id}\`${current}`;
}

/**
 * A heading, a list of models and a footer, within Discord's 2000 characters:
 * as many models as fit (at most {@link MAX_LISTED}), then "…and N more".
 */
function renderModelList(
  heading: string,
  models: readonly CatalogueModel[],
  chosenId: string | undefined,
  footer: string,
): string {
  const lines = models.map((model) => modelLine(model, chosenId));
  const shown = lines.slice(0, MAX_LISTED);
  const beyond = lines.length - shown.length;
  const more = (omitted: number) => `…and ${omitted + beyond} more.`;
  const budget = DISCORD_MAX_CHARS - heading.length - footer.length - 4;
  const body = beyond > 0
    ? fitLines([...shown, more(0)], budget, (omitted) => more(omitted - 1))
    : fitLines(shown, budget, more);
  return `${heading}\n${body}\n\n${footer}`;
}

/** What `/model` with no argument prints: the current model and the models, featured first. */
export function describeModels(catalogue: Catalogue, preferredModel: string | undefined): string {
  const chosenId = resolveRequestModel(preferredModel, catalogue);
  const current = `**Current model:** ${currentModelLabel(preferredModel, catalogue)}`;
  const models = modelsForListing(catalogue);
  if (models.length === 0) return `${current}\n\nNo models are available right now.`;
  const featured = models.some((model) => isFeatured(catalogue, model));
  return renderModelList(
    `${current}\n\n**${featured ? 'Featured models' : 'Models'}:**`,
    models,
    chosenId,
    SEARCH_HINT,
  );
}

/** The outcome of a `/model <text>` command: what to store (if anything) and what to say. */
export type ModelCommandReply =
  | { readonly kind: 'reply'; readonly message: string }
  | { readonly kind: 'store'; readonly model: string | null; readonly message: string };

/**
 * Decide what a `/model` command does, without doing it. `null` catalogue means
 * it could not be read, and nothing is stored: a model is only ever chosen from
 * what the catalogue lists.
 */
export function planModelCommand(
  catalogue: Catalogue | null,
  preferredModel: string | undefined,
  argument: string | null | undefined,
): ModelCommandReply {
  if (catalogue === null) return { kind: 'reply', message: CATALOGUE_UNAVAILABLE };
  const command = resolveModelCommand(argument, catalogue);
  switch (command.kind) {
    case 'list':
      return { kind: 'reply', message: describeModels(catalogue, preferredModel) };
    case 'reset':
      return {
        kind: 'store',
        model: null,
        message: `Alia will now use the **${defaultLabel(catalogue)}** model.`,
      };
    case 'select':
      return {
        kind: 'store',
        model: command.model.id,
        message: `Alia will now answer with **${command.model.name}** (\`${command.model.id}\`).`,
      };
    case 'matches':
      return {
        kind: 'reply',
        message: renderModelList(
          `**${command.models.length} models match ${quoted(command.query)}:**`,
          command.models,
          resolveRequestModel(preferredModel, catalogue),
          'Send `/model <id>` to pick one.',
        ),
      };
    case 'none':
      return {
        kind: 'reply',
        message: `No model matches ${quoted(command.query)}. ${SEARCH_HINT}`,
      };
  }
}

/** Run a `/model` command for a person: store the choice when there is one, and return the reply. */
export async function runModelCommand(
  platformUserId: string,
  preferredModel: string | undefined,
  argument: string | null | undefined,
): Promise<string> {
  const plan = planModelCommand(await apiClient.fetchCatalogue(), preferredModel, argument);
  if (plan.kind === 'store') await apiClient.updateModel(platformUserId, plan.model);
  return plan.message;
}

export async function registerSlashCommands(client: Client): Promise<void> {
  const commands = [
    new SlashCommandBuilder().setName('start').setDescription('Start using Alia AI / Link your account'),
    new SlashCommandBuilder().setName('status').setDescription('Check your account status'),
    new SlashCommandBuilder().setName('new').setDescription('Start a new conversation'),
    new SlashCommandBuilder()
      .setName('model')
      .setDescription('Choose the model Alia answers with')
      .addStringOption((opt) =>
        opt
          .setName('model')
          .setDescription('Model id, or text to search by name or publisher; "default" to reset')
          .setRequired(false),
      ),
    new SlashCommandBuilder().setName('help').setDescription('Show help'),
    new SlashCommandBuilder().setName('logout').setDescription('Disconnect your Alia account'),
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN!);

  try {
    await rest.put(Routes.applicationCommands(client.user!.id), {
      body: commands.map((c) => c.toJSON()),
    });
    logger.info('Slash commands registered');
  } catch (error) {
    logger.error('Failed to register slash commands:', error);
  }
}

export async function sendAuthRequest(message: Message): Promise<void> {
  try {
    await apiClient.createOrUpdateBotUser({
      platformUserId: message.author.id,
      chatId: message.channelId,
      displayName: message.author.displayName || message.author.username,
    });

    const { authUrl } = await apiClient.requestAuthToken(message.author.id);

    await message.reply({
      embeds: [
        {
          title: 'Link Your Alia Account',
          description: 'To use Alia AI on Discord, link your Alia account.',
          color: 0x5865f2,
          fields: [
            { name: 'Step 1', value: 'Click the link below to sign in', inline: false },
            { name: 'Step 2', value: 'Sign in with your Alia account', inline: false },
            { name: 'Step 3', value: 'Come back here and start chatting!', inline: false },
          ],
          footer: { text: 'Link expires in 15 minutes' },
        },
      ],
      components: [
        {
          type: 1,
          components: [{ type: 2, style: 5, label: 'Sign In to Alia', url: authUrl }],
        },
      ],
    });
  } catch (error) {
    logger.error('Auth error:', error);
    await message.reply('Authentication error. Please try again later.');
  }
}

export async function handleTextCommand(
  message: Message,
  command: string,
  args: string,
): Promise<boolean> {
  switch (command) {
    case 'start':
    case 'link':
      await sendAuthRequest(message);
      return true;
    case 'status':
      await handleStatus(message);
      return true;
    case 'new':
      await handleNewConversation(message);
      return true;
    case 'model':
      await handleModelChange(message, args);
      return true;
    case 'help':
      await handleHelp(message);
      return true;
    case 'logout':
      await handleLogout(message);
      return true;
    default:
      return false;
  }
}

async function handleStatus(message: Message): Promise<void> {
  try {
    const botUser = await apiClient.getBotUser(message.author.id);
    if (!botUser?.isLinked) {
      await sendAuthRequest(message);
      return;
    }
    // Omitted only when the catalogue could not be read.
    const catalogue = await apiClient.fetchCatalogue();
    const modelLabel = catalogue === null ? null : currentModelLabel(botUser.preferredModel, catalogue);
    await message.reply({
      embeds: [
        {
          title: 'Account Status',
          color: 0x00ff00,
          fields: [
            { name: 'Status', value: 'Connected', inline: true },
            ...(modelLabel === null ? [] : [{ name: 'Model', value: modelLabel, inline: true }]),
          ],
        },
      ],
    });
  } catch {
    await message.reply('Error checking status.');
  }
}

async function handleNewConversation(message: Message): Promise<void> {
  try {
    const botUser = await apiClient.getBotUser(message.author.id);
    if (!botUser?.isLinked) {
      await sendAuthRequest(message);
      return;
    }
    await apiClient.updateConversation(message.author.id, randomUUID());
    await message.reply('New conversation started! Send me a message.');
  } catch {
    await message.reply('Error starting new conversation.');
  }
}

async function handleModelChange(message: Message, typed: string): Promise<void> {
  try {
    const botUser = await apiClient.getBotUser(message.author.id);
    if (!botUser?.isLinked) {
      await sendAuthRequest(message);
      return;
    }
    await message.reply(await runModelCommand(message.author.id, botUser.preferredModel, typed));
  } catch {
    await message.reply('Error changing model.');
  }
}

async function handleHelp(message: Message): Promise<void> {
  await message.reply({
    embeds: [
      {
        title: 'Alia AI - Discord Bot',
        description: "DM me or @mention me in a channel to chat!",
        color: 0x5865f2,
        fields: [
          { name: '/start', value: 'Link your Alia account', inline: true },
          { name: '/status', value: 'Check status', inline: true },
          { name: '/new', value: 'Start new conversation', inline: true },
          { name: '/model [text]', value: 'Choose the model Alia answers with', inline: true },
          { name: '/help', value: 'Show help', inline: true },
          { name: '/logout', value: 'Disconnect', inline: true },
        ],
      },
    ],
  });
}

async function handleLogout(message: Message): Promise<void> {
  try {
    await apiClient.logoutUser(message.author.id);
    await message.reply('Logged out. Use /start to reconnect.');
  } catch {
    await message.reply('Error logging out.');
  }
}
