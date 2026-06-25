/** A single part of a multi-part chat message content array. */
export interface ContentPart {
  type: string;
  text?: string;
  image_url?: { url?: string };
  [key: string]: unknown;
}

export type MessageContent = string | ContentPart[];

/**
 * Extract text from message content, whether it's a string or multi-part array.
 */
export function getTextFromContent(content: MessageContent | null | undefined): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p.type === 'text')
      .map((p) => p.text || '')
      .join('');
  }
  return String(content || '');
}

/**
 * Extract image URLs from multi-part message content.
 */
export function getImagesFromContent(content: MessageContent | null | undefined): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((p): p is ContentPart & { image_url: { url: string } } =>
      p.type === 'image_url' && typeof p.image_url?.url === 'string',
    )
    .map((p) => p.image_url.url);
}
