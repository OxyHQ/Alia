import { Message, Client, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { APIClient } from '../../shared/api-client';
import { v4 as uuidv4 } from 'uuid';

let apiClient: APIClient;

export function initCommands(client: APIClient) {
  apiClient = client;
}

export async function registerSlashCommands(client: Client): Promise<void> {
  const commands = [
    new SlashCommandBuilder().setName('start').setDescription('Start using Alia AI / Link your account'),
    new SlashCommandBuilder().setName('status').setDescription('Check your account status'),
    new SlashCommandBuilder().setName('new').setDescription('Start a new conversation'),
    new SlashCommandBuilder()
      .setName('model')
      .setDescription('Change AI model')
      .addStringOption((opt) =>
        opt.setName('model').setDescription('Model name').setRequired(false),
      ),
    new SlashCommandBuilder().setName('help').setDescription('Show help'),
    new SlashCommandBuilder().setName('logout').setDescription('Disconnect your Alia account'),
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN!);

  try {
    await rest.put(Routes.applicationCommands(client.user!.id), {
      body: commands.map((c) => c.toJSON()),
    });
    console.log('[Discord] Slash commands registered');
  } catch (error) {
    console.error('[Discord] Failed to register slash commands:', error);
  }
}

export async function sendAuthRequest(message: Message): Promise<void> {
  try {
    await apiClient.createOrUpdateChannelUser({
      channelUserId: message.author.id,
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
    console.error('[Discord/Auth] Error:', error);
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
    const channelUser = await apiClient.getChannelUser(message.author.id);
    if (!channelUser?.isAuthenticated) {
      await sendAuthRequest(message);
      return;
    }
    await message.reply({
      embeds: [
        {
          title: 'Account Status',
          color: 0x00ff00,
          fields: [
            { name: 'Status', value: 'Connected', inline: true },
            { name: 'Model', value: channelUser.preferredModel || 'alia-lite', inline: true },
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
    const channelUser = await apiClient.getChannelUser(message.author.id);
    if (!channelUser?.isAuthenticated) {
      await sendAuthRequest(message);
      return;
    }
    await apiClient.updateConversation(message.author.id, uuidv4());
    await message.reply('New conversation started! Send me a message.');
  } catch {
    await message.reply('Error starting new conversation.');
  }
}

async function handleModelChange(message: Message, modelName: string): Promise<void> {
  try {
    const channelUser = await apiClient.getChannelUser(message.author.id);
    if (!channelUser?.isAuthenticated) {
      await sendAuthRequest(message);
      return;
    }
    if (!modelName) {
      const models = await apiClient.fetchModels();
      const list = models.map((m: any) => `\`${m.id}\` - ${m.name}`).join('\n');
      await message.reply(`**Available Models:**\n${list || 'None'}\n\nCurrent: ${channelUser.preferredModel || 'alia-lite'}`);
      return;
    }
    await apiClient.updateModel(message.author.id, modelName);
    await message.reply(`Model changed to **${modelName}**`);
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
          { name: '/model', value: 'Change AI model', inline: true },
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
