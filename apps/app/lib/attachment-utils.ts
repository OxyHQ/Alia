import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';
import type { Attachment } from './globalStore';

export type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * Build multi-part message content from text + attachments.
 * Converts native file URIs to base64 data URLs.
 * Returns a plain string if no image attachments, or an array of parts.
 */
export async function buildMessageContent(
  text: string,
  attachments: Attachment[]
): Promise<string | MessageContentPart[]> {
  const imageAttachments = attachments.filter(a => a.type === 'image' && a.uri);
  if (imageAttachments.length === 0) return text;

  const parts: MessageContentPart[] = [{ type: 'text', text }];

  for (const att of imageAttachments) {
    let dataUrl = att.uri;

    // Native file URIs (file://) need base64 conversion
    if (!att.uri.startsWith('data:') && Platform.OS !== 'web') {
      try {
        const base64 = await FileSystem.readAsStringAsync(att.uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        dataUrl = `data:${att.mimeType || 'image/jpeg'};base64,${base64}`;
      } catch {
        // Skip this attachment if conversion fails
        continue;
      }
    }

    parts.push({
      type: 'image_url',
      image_url: { url: dataUrl },
    });
  }

  return parts;
}

/**
 * Extract text from message content, whether it's a string or multi-part array.
 */
export function getTextFromContent(content: string | MessageContentPart[] | any): string {
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
export function getImagesFromContent(content: string | MessageContentPart[] | any): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((p: any) => p.type === 'image_url' && p.image_url?.url)
    .map((p: any) => p.image_url.url);
}
