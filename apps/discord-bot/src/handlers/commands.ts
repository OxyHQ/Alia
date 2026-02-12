import { Message, Client, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { apiClient } from '../services/api-client';
import { sendAuthRequest, handleStatus } from './auth';
import { v4 as uuidv4 } from 'uuid';

export async function registerSlashCommands(client: Client): Promise<void> {
  const commands = [
    new SlashCommandBuilder().setName('start').setDescription('Start using Alia AI / Link your account'),
    new SlashCommandBuilder().setName('status').setDescription('Check your account status'),
    new SlashCommandBuilder().setName('new').setDescription('Start a new conversation'),
    new SlashCommandBuilder().setName('model').setDescription('Change AI model')
      .addStringOption(opt => opt.setName('model').setDescription('Model name').setRequired(false)),
    new SlashCommandBuilder().setName('help').setDescription('Show help'),
    new SlashCommandBuilder().setName('logout').setDescription('Disconnect your Alia account'),
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN!);

  try {
    await rest.put(
      Routes.applicationCommands(client.user!.id),
      { body: commands.map(c => c.toJSON()) }
    );
    console.log('[Commands] Slash commands registered');
  } catch (error) {
    console.error('[Commands] Failed to register slash commands:', error);
  }
}

export async function handleTextCommand(message: Message, command: string, args: string): Promise<boolean> {
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

async function handleNewConversation(message: Message): Promise<void> {
  try {
    const channelUser = await apiClient.getChannelUser(message.author.id);
    if (!channelUser?.isAuthenticated) {
      await sendAuthRequest(message);
      return;
    }

    const newConversationId = uuidv4();
    await apiClient.updateConversation(message.author.id, newConversationId);
    await message.reply('✨ **New conversation started!** Send me a message to begin.');
  } catch (error) {
    console.error('[Commands] New conversation error:', error);
    await message.reply('❌ Error starting new conversation.');
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
      const modelList = models.map(m => `• \`${m.id}\` - ${m.name}`).join('\n');
      await message.reply({
        embeds: [{
          title: '🤖 Available Models',
          description: modelList || 'No models available',
          color: 0x5865F2,
          footer: { text: `Current: ${channelUser.preferredModel || 'alia-lite'}. Use /model <name> to switch.` },
        }],
      });
      return;
    }

    await apiClient.updateModel(message.author.id, modelName);
    await message.reply(`✅ Model changed to **${modelName}**`);
  } catch (error) {
    console.error('[Commands] Model change error:', error);
    await message.reply('❌ Error changing model.');
  }
}

async function handleHelp(message: Message): Promise<void> {
  await message.reply({
    embeds: [{
      title: '🤖 Alia AI - Discord Bot',
      description: 'I\'m Alia, your AI assistant on Discord!',
      color: 0x5865F2,
      fields: [
        { name: 'Chat', value: 'Just send me a message or mention @Alia in a channel', inline: false },
        { name: '/start', value: 'Link your Alia account', inline: true },
        { name: '/status', value: 'Check account status', inline: true },
        { name: '/new', value: 'Start new conversation', inline: true },
        { name: '/model', value: 'Change AI model', inline: true },
        { name: '/help', value: 'Show this help', inline: true },
        { name: '/logout', value: 'Disconnect account', inline: true },
      ],
    }],
  });
}

async function handleLogout(message: Message): Promise<void> {
  try {
    await apiClient.logoutUser(message.author.id);
    await message.reply('👋 You have been logged out. Use /start to reconnect.');
  } catch (error) {
    console.error('[Commands] Logout error:', error);
    await message.reply('❌ Error logging out.');
  }
}
