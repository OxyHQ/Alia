/**
 * Extract text from message content, whether it's a string or multi-part array.
 */
export function getTextFromContent(content: string | Array<{ type: string; [key: string]: any }> | any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text || '')
      .join('');
  }
  return String(content || '');
}

/**
 * Extract image URLs from multi-part message content.
 */
export function getImagesFromContent(content: string | Array<{ type: string; [key: string]: any }> | any): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((p: any) => p.type === 'image_url' && p.image_url?.url)
    .map((p: any) => p.image_url.url);
}
