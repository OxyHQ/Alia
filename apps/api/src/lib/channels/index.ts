import { registerChannel } from './registry.js';
import { discordPlugin } from './plugins/discord.js';
import { whatsappPlugin } from './plugins/whatsapp.js';
import { slackPlugin } from './plugins/slack.js';
import { signalPlugin } from './plugins/signal.js';

export function initChannels() {
  registerChannel(discordPlugin);
  registerChannel(whatsappPlugin);
  registerChannel(slackPlugin);
  registerChannel(signalPlugin);
}

export * from './types.js';
export * from './registry.js';
export * from './outbound.js';
