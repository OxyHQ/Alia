import type { AliaAttachment } from '../types';

export type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { file_id: string; filename: string; mime: string } };

export interface BuiltMessageContent {
  content: string | MessageContentPart[];
  /**
   * Attachments the request does NOT carry, so the caller can say so.
   *
   * Never empty silently: everything here was visibly attached in the composer,
   * and a file that appears attached and then is not sent is the failure #608
   * §1.6 is about — a visible state that does not correspond to a real
   * capability.
   */
  dropped: DroppedAttachment[];
}

export interface DroppedAttachment {
  name: string;
  /**
   * `unsupported` — the chat has no way to send a document (no upload was given).
   * `unreadable` — an image whose bytes could not be read off the device, or a
   * document that could not be uploaded.
   */
  reason: 'unsupported' | 'unreadable';
}

/** Puts a document in the person's Oxy Files and answers its id. */
export type UploadDocument = (attachment: AliaAttachment) => Promise<string>;

/**
 * The request body for a turn that carries attachments, and an account of what
 * it could not carry.
 *
 * A photo travels inline, as an `image_url` part with its `data:` URL. A
 * document travels as a `file` part naming an Oxy Files id
 * (`docs/agent-embedding.md` §5): it is uploaded to the person's Files first,
 * with `upload`, and a chat given no `upload` cannot send documents and says so.
 */
export async function buildMessageContent(
  text: string,
  attachments: AliaAttachment[],
  upload?: UploadDocument,
): Promise<BuiltMessageContent> {
  const dropped: DroppedAttachment[] = [];

  const usable = attachments.filter((att) => {
    if (!att.uri) return false;
    if (att.type !== 'image' && upload === undefined) {
      dropped.push({ name: att.name, reason: 'unsupported' });
      return false;
    }
    return true;
  });

  if (usable.length === 0) return { content: text, dropped };

  const parts: MessageContentPart[] = [{ type: 'text', text }];

  // The readers need the platform's file access, loaded on the first attachment: a turn of plain
  // text (and everything that imports this module) never touches it.
  const { imageUriToDataUrl } = await import('../lib/image-data-url');
  for (const att of usable) {
    if (att.type !== 'image' && upload !== undefined) {
      try {
        const fileId = await upload(att);
        parts.push({
          type: 'file',
          file: { file_id: fileId, filename: att.name, mime: att.mimeType },
        });
      } catch {
        dropped.push({ name: att.name, reason: 'unreadable' });
      }
      continue;
    }
    try {
      parts.push({
        type: 'image_url',
        image_url: { url: await imageUriToDataUrl(att.uri, att.mimeType) },
      });
    } catch {
      // Reported rather than skipped. A picture that did not arrive is worth
      // a sentence; it used to be a `continue`.
      dropped.push({ name: att.name, reason: 'unreadable' });
    }
  }

  // Every attachment failed, so the parts array is a text part and nothing
  // else — which is just the text, said in a more expensive way.
  if (parts.length === 1) return { content: text, dropped };

  return { content: parts, dropped };
}
