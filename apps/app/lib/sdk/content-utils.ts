/**
 * Extract text from message content, whether it's a string or multi-part array.
 */
export function getTextFromContent(content: string | Array<{ type: string; [key: string]: unknown }> | unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p.type === 'text')
      .map((p) => (p as Record<string, unknown>).text || '')
      .join('');
  }
  return String(content || '');
}

/**
 * Extract image URLs from multi-part message content.
 */
export function getImagesFromContent(content: string | Array<{ type: string; [key: string]: unknown }> | unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((p) => p.type === 'image_url' && (p as Record<string, Record<string, string>>).image_url?.url)
    .map((p) => (p as Record<string, Record<string, string>>).image_url.url);
}
