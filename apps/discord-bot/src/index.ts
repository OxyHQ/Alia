import 'dotenv/config';
import { Client, GatewayIntentBits, Events, Partials } from 'discord.js';
import { handleMessage } from './handlers/chat';
import { handleTextCommand, registerSlashCommands } from './handlers/commands';
import { sendAuthRequest, handleStatus } from './handlers/auth';

// Validate environment
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const API_BASE_URL = process.env.API_BASE_URL;
const DISCORD_BOT_SECRET = process.env.DISCORD_BOT_SECRET;

if (!DISCORD_BOT_TOKEN) {
  console.error('DISCORD_BOT_TOKEN is required');
  process.exit(1);
}
if (!API_BASE_URL) {
  console.error('API_BASE_URL is required');
  process.exit(1);
}
if (!DISCORD_BOT_SECRET) {
  console.error('DISCORD_BOT_SECRET is required');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel], // Required for DMs
});

client.once(Events.ClientReady, async (c) => {
  console.log(`[Discord Bot] Logged in as ${c.user.tag}`);
  console.log(`[Discord Bot] Connected to ${c.guilds.cache.size} guild(s)`);

  // Register slash commands
  await registerSlashCommands(client);
});

// Handle messages
client.on(Events.MessageCreate, async (message) => {
  // Ignore bot messages
  if (message.author.bot) return;

  // Check if it's a DM or mentions the bot
  const isDM = !message.guild;
  const isMentioned = message.mentions.has(client.user!);

  if (!isDM && !isMentioned) return;

  // Remove bot mention from message content
  let content = message.content;
  if (isMentioned) {
    content = content.replace(new RegExp(`<@!?${client.user!.id}>`), '').trim();
  }

  // Check for text commands (prefixed with ! or /)
  const commandMatch = content.match(/^[!/](\w+)\s*(.*)/);
  if (commandMatch) {
    const [, command, args] = commandMatch;
    const handled = await handleTextCommand(message, command.toLowerCase(), args.trim());
    if (handled) return;
  }

  // Skip empty messages (just a mention with no text)
  if (!content) {
    await message.reply('👋 Hi! Send me a message or use /help to see available commands.');
    return;
  }

  // Process as chat message (override content with cleaned version)
  const originalContent = message.content;
  (message as any).content = content;
  await handleMessage(message);
  (message as any).content = originalContent;
});

// Handle slash command interactions
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  switch (commandName) {
    case 'start':
      await interaction.reply({ content: '🔐 Setting up...', ephemeral: true });
      // Trigger auth flow via DM
      try {
        const user = interaction.user;
        const dm = await user.createDM();
        await dm.send('Let me help you link your Alia account...');
        // The DM will trigger the auth flow via messageCreate
        await interaction.editReply('📩 Check your DMs! I\'ve sent you a link to sign in.');
      } catch {
        await interaction.editReply('❌ Please enable DMs from server members to use this bot.');
      }
      break;

    case 'status':
      await interaction.deferReply({ ephemeral: true });
      try {
        const { apiClient } = await import('./services/api-client');
        const channelUser = await apiClient.getChannelUser(interaction.user.id);
        if (!channelUser?.isAuthenticated) {
          await interaction.editReply('❌ Not linked. Use /start to connect your Alia account.');
        } else {
          await interaction.editReply(`✅ Connected | Model: ${channelUser.preferredModel || 'alia-lite'}`);
        }
      } catch {
        await interaction.editReply('❌ Error checking status.');
      }
      break;

    case 'new':
      await interaction.deferReply({ ephemeral: true });
      try {
        const { apiClient } = await import('./services/api-client');
        const { v4: uuidv4 } = await import('uuid');
        const newId = uuidv4();
        await apiClient.updateConversation(interaction.user.id, newId);
        await interaction.editReply('✨ New conversation started!');
      } catch {
        await interaction.editReply('❌ Error starting new conversation.');
      }
      break;

    case 'model':
      await interaction.deferReply({ ephemeral: true });
      try {
        const { apiClient } = await import('./services/api-client');
        const modelArg = interaction.options.getString('model');
        if (!modelArg) {
          const models = await apiClient.fetchModels();
          const list = models.map(m => `\`${m.id}\` - ${m.name}`).join('\n');
          await interaction.editReply(`**Available Models:**\n${list || 'None'}`);
        } else {
          await apiClient.updateModel(interaction.user.id, modelArg);
          await interaction.editReply(`✅ Model changed to **${modelArg}**`);
        }
      } catch {
        await interaction.editReply('❌ Error with model command.');
      }
      break;

    case 'help':
      await interaction.reply({
        embeds: [{
          title: '🤖 Alia AI - Discord Bot',
          description: 'DM me or @mention me in a channel to chat!',
          color: 0x5865F2,
          fields: [
            { name: '/start', value: 'Link your Alia account' },
            { name: '/status', value: 'Check connection status' },
            { name: '/new', value: 'Start new conversation' },
            { name: '/model [name]', value: 'View or change AI model' },
            { name: '/logout', value: 'Disconnect account' },
          ],
        }],
        ephemeral: true,
      });
      break;

    case 'logout':
      await interaction.deferReply({ ephemeral: true });
      try {
        const { apiClient } = await import('./services/api-client');
        await apiClient.logoutUser(interaction.user.id);
        await interaction.editReply('👋 Logged out. Use /start to reconnect.');
      } catch {
        await interaction.editReply('❌ Error logging out.');
      }
      break;
  }
});

// Handle errors
client.on(Events.Error, (error) => {
  console.error('[Discord Bot] Client error:', error);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Discord Bot] Shutting down...');
  client.destroy();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[Discord Bot] Shutting down...');
  client.destroy();
  process.exit(0);
});

// Login
console.log('[Discord Bot] Connecting to Discord...');
client.login(DISCORD_BOT_TOKEN);
