import { Client, GatewayIntentBits, Events, Partials } from 'discord.js';
import { v4 as uuidv4 } from 'uuid';
import type { BotAdapter } from '../types';
import { APIClient } from '../../shared/api-client';
import { chunkText } from '../../shared/utils';
import {
  initCommands,
  registerSlashCommands,
  handleTextCommand,
  sendAuthRequest,
} from './commands';

const apiClient = new APIClient('discord', process.env.DISCORD_BOT_SECRET || '');

export class DiscordBotAdapter implements BotAdapter {
  name = 'discord-bot';
  private client: Client;

  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });
  }

  async initialize() {
    initCommands(apiClient);

    this.client.once(Events.ClientReady, async (c) => {
      console.log(`[Discord] Logged in as ${c.user.tag}`);
      await registerSlashCommands(this.client);
    });

    // Message handler
    this.client.on(Events.MessageCreate, async (message) => {
      if (message.author.bot) return;

      const isDM = !message.guild;
      const isMentioned = message.mentions.has(this.client.user!);
      if (!isDM && !isMentioned) return;

      let content = message.content;
      if (isMentioned) {
        content = content.replace(new RegExp(`<@!?${this.client.user!.id}>`), '').trim();
      }

      // Text commands
      const commandMatch = content.match(/^[!/](\w+)\s*(.*)/);
      if (commandMatch) {
        const [, command, args] = commandMatch;
        const handled = await handleTextCommand(message, command.toLowerCase(), args.trim());
        if (handled) return;
      }

      if (!content) {
        await message.reply('Hi! Send me a message or use /help.');
        return;
      }

      // Process chat message
      await this.handleChat(message, content);
    });

    // Slash command interactions
    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      const { commandName } = interaction;

      switch (commandName) {
        case 'start':
          await interaction.reply({ content: 'Setting up...', ephemeral: true });
          try {
            const dm = await interaction.user.createDM();
            await dm.send('Let me help you link your Alia account...');
            await interaction.editReply('Check your DMs!');
          } catch {
            await interaction.editReply('Please enable DMs from server members.');
          }
          break;

        case 'status':
          await interaction.deferReply({ ephemeral: true });
          try {
            const botUser = await apiClient.getBotUser(interaction.user.id);
            if (!botUser?.isLinked) {
              await interaction.editReply('Not linked. Use /start to connect.');
            } else {
              await interaction.editReply(`Connected | Model: ${botUser.preferredModel || 'alia-lite'}`);
            }
          } catch {
            await interaction.editReply('Error checking status.');
          }
          break;

        case 'new':
          await interaction.deferReply({ ephemeral: true });
          try {
            await apiClient.updateConversation(interaction.user.id, uuidv4());
            await interaction.editReply('New conversation started!');
          } catch {
            await interaction.editReply('Error starting new conversation.');
          }
          break;

        case 'model':
          await interaction.deferReply({ ephemeral: true });
          try {
            const modelArg = interaction.options.getString('model');
            if (!modelArg) {
              const models = await apiClient.fetchModels();
              const list = models.map((m: any) => `\`${m.id}\` - ${m.name}`).join('\n');
              await interaction.editReply(`**Available Models:**\n${list || 'None'}`);
            } else {
              await apiClient.updateModel(interaction.user.id, modelArg);
              await interaction.editReply(`Model changed to **${modelArg}**`);
            }
          } catch {
            await interaction.editReply('Error with model command.');
          }
          break;

        case 'help':
          await interaction.reply({
            embeds: [{
              title: 'Alia AI - Discord Bot',
              description: 'DM me or @mention me to chat!',
              color: 0x5865f2,
              fields: [
                { name: '/start', value: 'Link account' },
                { name: '/status', value: 'Check status' },
                { name: '/new', value: 'New conversation' },
                { name: '/model [name]', value: 'Change model' },
                { name: '/logout', value: 'Disconnect' },
              ],
            }],
            ephemeral: true,
          });
          break;

        case 'logout':
          await interaction.deferReply({ ephemeral: true });
          try {
            await apiClient.logoutUser(interaction.user.id);
            await interaction.editReply('Logged out. Use /start to reconnect.');
          } catch {
            await interaction.editReply('Error logging out.');
          }
          break;
      }
    });

    this.client.on(Events.Error, (error) => {
      console.error('[Discord] Client error:', error);
    });

    await this.client.login(process.env.DISCORD_BOT_TOKEN);
  }

  async shutdown() {
    this.client.destroy();
  }

  /**
   * Chat handler — uses generateText (single-shot) with Discord-specific formatting.
   * Discord bot has unique behavior: sends "Thinking..." message first, then edits it.
   */
  private async handleChat(message: any, content: string) {
    const discordUserId = message.author.id;

    try {
      let botUser: any;
      try {
        botUser = await apiClient.getBotUser(discordUserId);
      } catch (error: any) {
        if (error.response?.status === 404) {
          await apiClient.createOrUpdateBotUser({
            platformUserId: discordUserId,
            chatId: message.channelId,
            displayName: message.author.displayName || message.author.username,
          });
          await sendAuthRequest(message);
          return;
        }
        throw error;
      }

      if (!botUser?.isLinked || !botUser?.oxyUserId) {
        await sendAuthRequest(message);
        return;
      }

      // Show typing
      if ('sendTyping' in message.channel) {
        await message.channel.sendTyping();
      }
      const typingInterval = setInterval(() => {
        if ('sendTyping' in message.channel) {
          message.channel.sendTyping().catch(() => {});
        }
      }, 5000);

      try {
        let conversationId = botUser.conversationId;
        if (!conversationId) {
          conversationId = uuidv4();
          await apiClient.updateConversation(discordUserId, conversationId);
        }

        // Load conversation history (user/assistant only)
        let messages_history: Array<{ role: string; content: string }> = [];
        try {
          const conversation = await apiClient.getConversation(botUser.oxyUserId, conversationId);
          if (conversation?.messages?.length) {
            messages_history = conversation.messages
              .filter((m: any) => m.role === 'user' || m.role === 'assistant')
              .slice(-20)
              .map((m: any) => ({ role: m.role, content: m.content }));
          }
        } catch {}

        messages_history.push({ role: 'user', content });

        const thinkingMsg = await message.reply('Thinking...');

        // Platform instructions as first system message
        const apiMessages = [
          {
            role: 'system',
            content: 'The user is chatting via Discord. Be concise and friendly. Use Discord markdown. Keep responses under 1800 characters when possible.',
          },
          ...messages_history,
        ];

        const result = await apiClient.chatCompletion(
          botUser.oxyUserId,
          apiMessages,
          {
            model: botUser.preferredModel || 'alia-lite',
            conversationId,
          },
        );

        const fullResponse = result.content;

        if (fullResponse) {
          const chunks = chunkText(fullResponse, 2000);
          await thinkingMsg.edit(chunks[0]);
          for (let i = 1; i < chunks.length; i++) {
            if ('send' in message.channel) {
              await message.channel.send(chunks[i]);
            }
          }
        } else {
          await thinkingMsg.edit("Couldn't generate a response. Please try again.");
        }

        // Conversation is auto-saved by the API when conversationId is provided
      } finally {
        clearInterval(typingInterval);
      }
    } catch (error: any) {
      console.error('[Discord/Chat] Error:', error);
      await message.reply('Sorry, an error occurred. Please try again.').catch(() => {});
    }
  }
}
