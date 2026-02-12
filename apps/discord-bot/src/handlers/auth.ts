import { Message } from 'discord.js';
import { apiClient } from '../services/api-client';

export async function sendAuthRequest(message: Message): Promise<void> {
  const discordUserId = message.author.id;

  try {
    // Create/update channel user
    await apiClient.createOrUpdateChannelUser({
      channelUserId: discordUserId,
      chatId: message.channel.id,
      username: message.author.username,
      displayName: message.author.displayName || message.author.username,
    });

    // Generate auth token
    const { authUrl, expiresAt } = await apiClient.requestAuthToken(discordUserId);

    await message.reply({
      embeds: [{
        title: '🔐 Link Your Alia Account',
        description: 'To use Alia AI on Discord, you need to link your Alia account.',
        color: 0x5865F2,
        fields: [
          { name: 'Step 1', value: 'Click the link below to sign in', inline: false },
          { name: 'Step 2', value: 'Sign in with your Alia account', inline: false },
          { name: 'Step 3', value: 'Come back here and start chatting!', inline: false },
        ],
        footer: { text: `Link expires in 15 minutes` },
      }],
      components: [{
        type: 1, // ActionRow
        components: [{
          type: 2, // Button
          style: 5, // Link
          label: '🔗 Sign In to Alia',
          url: authUrl,
        }],
      }],
    });
  } catch (error) {
    console.error('[Auth] Error sending auth request:', error);
    await message.reply('❌ Authentication error. Please try again later.');
  }
}

export async function handleStatus(message: Message): Promise<void> {
  try {
    const channelUser = await apiClient.getChannelUser(message.author.id);

    if (!channelUser || !channelUser.isAuthenticated) {
      await sendAuthRequest(message);
      return;
    }

    await message.reply({
      embeds: [{
        title: '📊 Account Status',
        color: 0x00FF00,
        fields: [
          { name: 'Status', value: '✅ Connected', inline: true },
          { name: 'Discord User', value: `@${message.author.username}`, inline: true },
          { name: 'Model', value: channelUser.preferredModel || 'alia-lite', inline: true },
          { name: 'Linked', value: channelUser.linkedAt ? new Date(channelUser.linkedAt).toLocaleDateString() : 'Unknown', inline: true },
        ],
      }],
    });
  } catch (error) {
    console.error('[Auth] Status error:', error);
    await message.reply('❌ Error checking status.');
  }
}
