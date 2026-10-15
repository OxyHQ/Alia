import type { AliaAttachment } from '../types';

export type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

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
   * `unsupported` — the request format carries images and nothing else, so a
   * document has nowhere to go.
   * `unreadable` — an image whose bytes could not be read off the device.
   */
  reason: 'unsupported' | 'unreadable';
}

/**
 * The request body for a turn that carries attachments, and an account of what
 * it could not carry.
 *
 * Only images reach the model: the parts array this builds is the AI SDK's
 * `text` / `image_url` shape and there is no document part in it. That is a
 * real limit of the current request format rather than an oversight here —
 * whether Alia sends documents is a product decision, and inventing a part
 * shape the backend has never seen would be a worse answer than reporting the
 * limit.
 *
 * What is NOT acceptable is the way it used to be reported, which was not at
 * all: `attachments.filter(a => a.type === 'image' && a.uri)` dropped every
 * document on the floor, and the composer had already shown it attached. The
 * turn went out, the file did not, and nothing said so.
 */
export async function buildMessageContent(
  text: string,
  attachments: AliaAttachment[],
): Promise<BuiltMessageContent> {
  const dropped: DroppedAttachment[] = [];

  const usable = attachments.filter((att) => {
    if (!att.uri) return false;
    if (att.type !== 'image') {
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

  // Every image failed to read, so the parts array is a text part and nothing
  // else — which is just the text, said in a more expensive way.
  if (parts.length === 1) return { content: text, dropped };

  return { content: parts, dropped };
}
