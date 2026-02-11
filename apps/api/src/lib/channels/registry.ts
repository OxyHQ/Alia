import type { ChannelPlugin, ChannelId, ChannelOutboundAdapter } from './types.js';

const channels: ChannelPlugin[] = [];
const outboundCache = new Map<ChannelId, ChannelOutboundAdapter>();

export function registerChannel(plugin: ChannelPlugin): void {
  const existing = channels.findIndex(c => c.id === plugin.id);
  if (existing !== -1) {
    channels[existing] = plugin;
  } else {
    channels.push(plugin);
  }
  outboundCache.set(plugin.id, plugin.outbound);
}

export function getChannel(id: ChannelId): ChannelPlugin | undefined {
  return channels.find(c => c.id === id);
}

export function listChannels(): ChannelPlugin[] {
  return [...channels];
}

export function getConfiguredChannels(): ChannelPlugin[] {
  return channels.filter(c => c.config.isConfigured());
}

export function getCachedOutbound(id: ChannelId): ChannelOutboundAdapter | undefined {
  return outboundCache.get(id);
}
