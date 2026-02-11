import { getChannel, getCachedOutbound } from './registry.js';
import type { ChannelId, OutboundContext, OutboundResult } from './types.js';

function defaultChunker(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = '';

  for (const para of paragraphs) {
    if (para.length > limit) {
      if (current) {
        chunks.push(current.trim());
        current = '';
      }
      let remaining = para;
      while (remaining.length > limit) {
        const breakAt = remaining.lastIndexOf(' ', limit);
        const splitAt = breakAt > 0 ? breakAt : limit;
        chunks.push(remaining.slice(0, splitAt).trim());
        remaining = remaining.slice(splitAt).trim();
      }
      if (remaining) current = remaining;
    } else if ((current + '\n\n' + para).trim().length > limit) {
      if (current) chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text.slice(0, limit)];
}

export async function sendChannelMessage(
  channelId: ChannelId,
  to: string,
  text: string,
  opts?: Omit<OutboundContext, 'to' | 'text'>
): Promise<OutboundResult[]> {
  const channel = getChannel(channelId);
  if (!channel) {
    return [{ channel: channelId, ok: false, error: `Channel "${channelId}" not registered` }];
  }

  const outbound = getCachedOutbound(channelId) ?? channel.outbound;
  const chunker = outbound.chunker ?? defaultChunker;
  const chunks = chunker(text, channel.meta.textChunkLimit);
  const results: OutboundResult[] = [];

  for (const chunk of chunks) {
    const ctx: OutboundContext = { to, text: chunk, ...opts };
    try {
      const result = await outbound.sendText(ctx);
      results.push(result);
      if (!result.ok) break;
    } catch (err: any) {
      results.push({
        channel: channelId,
        ok: false,
        error: err.message || 'Unknown send error',
      });
      break;
    }
  }

  return results;
}
