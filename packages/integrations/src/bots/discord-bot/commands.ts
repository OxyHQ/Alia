import { Message, Client, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { APIClient } from '../../shared/api-client';
import { labelForPreference } from '../../shared/catalogue';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../../shared/logger';

const logger = createLogger('Discord');

let apiClient: APIClient;

export function initCommands(client: APIClient) {
  apiClient = client;
}

/**
 * The modes on offer, written out for a person.
 *
 * Labels only, never identifiers: `profile:lite` is the vocabulary the request
 * travels in, not a thing to put in front of somebody. {@link resolveModeChoice}
 * is what turns what they type back into one.
 */
export async function describeModes(preferredModel: string | undefined): Promise<string> {
  const offeredModes = await apiClient.fetchOfferedModes();
  if (offeredModes === null) return 'Unable to load the available modes. Please try again later.';

  const list = offeredModes.offered
    .map((mode) => `**${mode.label}** — ${mode.description}`)
    .join('\n');
  const current = labelForPreference(
    preferredModel,
    offeredModes.entries,
    offeredModes.modes,
  );
  const heading = list === '' ? 'No modes are on offer right now.' : `**How Alia can answer:**\n${list}`;
  return current === null ? heading : `${heading}\n\nCurrent: ${current}`;
}

/** What a person typed, resolved to the identifier a request travels in. */
export type ModeChoice =
  | { readonly ok: true; readonly id: string; readonly label: string }
  | { readonly ok: false; readonly message: string };

/**
 * Match what somebody typed against the offered modes, by LABEL.
 *
 * A person types "Fast", not `profile:lite`, and matching on the label is what
 * makes the product's own words the interface. An unmatched value is refused
 * with the list rather than saved: the previous behaviour stored the raw string
 * unchecked, so a typo became a preference that every later request carried.
 */
export async function resolveModeChoice(
  typed: string,
  preferredModel: string | undefined,
): Promise<ModeChoice> {
  const offeredModes = await apiClient.fetchOfferedModes();
  if (offeredModes === null) {
    return { ok: false, message: 'Unable to load the available modes. Please try again later.' };
  }
  const wanted = typed.trim().toLowerCase();
  const match = offeredModes.offered.find((mode) => mode.label.toLowerCase() === wanted);
  if (match === undefined) {
    return { ok: false, message: await describeModes(preferredModel) };
  }
  return { ok: true, id: match.id, label: match.label };
}

export async function registerSlashCommands(client: Client): Promise<void> {
  const commands = [
    new SlashCommandBuilder().setName('start').setDescription('Start using Alia AI / Link your account'),
    new SlashCommandBuilder().setName('status').setDescription('Check your account status'),
    new SlashCommandBuilder().setName('new').setDescription('Start a new conversation'),
    new SlashCommandBuilder()
      .setName('model')
      .setDescription('Choose how Alia answers')
      .addStringOption((opt) =>
        opt.setName('mode').setDescription('Mode name, e.g. Fast').setRequired(false),
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
    /**
     * Absent when the stored preference is a legacy identifier the catalogue
     * does not describe — the product has no word for it, and printing the
     * identifier is the defect this replaces. See `shared/catalogue.ts`.
     */
    const offeredModes = await apiClient.fetchOfferedModes();
    const modeLabel = offeredModes === null
      ? null
      : labelForPreference(botUser.preferredModel, offeredModes.entries, offeredModes.modes);
    await message.reply({
      embeds: [
        {
          title: 'Account Status',
          color: 0x00ff00,
          fields: [
            { name: 'Status', value: 'Connected', inline: true },
            ...(modeLabel === null ? [] : [{ name: 'Mode', value: modeLabel, inline: true }]),
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
    if (!typed) {
      await message.reply(await describeModes(botUser.preferredModel));
      return;
    }
    const choice = await resolveModeChoice(typed, botUser.preferredModel);
    if (!choice.ok) {
      await message.reply(choice.message);
      return;
    }
    await apiClient.updateModel(message.author.id, choice.id);
    await message.reply(`Alia will now answer in **${choice.label}** mode.`);
  } catch {
    await message.reply('Error changing mode.');
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
          { name: '/model', value: 'Choose how Alia answers', inline: true },
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
