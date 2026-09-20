import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';
import type { Attachment } from './stores/global-store';

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

/** A URL the request body can carry: the bytes are IN it. */
function isInlineData(uri: string): boolean {
  return uri.startsWith('data:');
}

/**
 * Read a browser object URL back into an inline one.
 *
 * On web both Expo pickers hand back `URL.createObjectURL(file)` — see
 * `expo-image-picker`'s `readFile` and `expo-document-picker`'s
 * `ExpoDocumentPicker.web.js`. A `blob:` URL is a handle into THIS tab's
 * memory: it means nothing to the API, nothing to Kaana and nothing to the
 * model, and it cannot be dereferenced from anywhere but the page that minted
 * it.
 *
 * The conversion that existed was gated on `Platform.OS !== 'web'`, so every
 * image picked in a browser was sent as `blob:http://…` and arrived as a
 * string the model could not open. Native was fine; web has been sending
 * unusable references.
 */
async function inlineObjectUrl(uri: string, mimeType?: string): Promise<string> {
  const response = await fetch(uri);
  const blob = await response.blob();

  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('unexpected reader result'));
        return;
      }
      // `readAsDataURL` already stamps the blob's own type. It is only absent
      // when the blob has none, and then the attachment's is the better guess.
      resolve(
        result.startsWith('data:application/octet-stream') && mimeType
          ? result.replace('data:application/octet-stream', `data:${mimeType}`)
          : result,
      );
    };
    reader.readAsDataURL(blob);
  });
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
  attachments: Attachment[]
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

  for (const att of usable) {
    let url = att.uri;

    if (!isInlineData(url)) {
      try {
        url = Platform.OS === 'web'
          ? await inlineObjectUrl(att.uri, att.mimeType)
          // Native file URIs (`file://`) are read off the filesystem.
          : `data:${att.mimeType || 'image/jpeg'};base64,${await FileSystem.readAsStringAsync(att.uri, {
              encoding: FileSystem.EncodingType.Base64,
            })}`;
      } catch {
        // Reported rather than skipped. A picture that did not arrive is worth
        // a sentence; it used to be a `continue`.
        dropped.push({ name: att.name, reason: 'unreadable' });
        continue;
      }
    }

    parts.push({ type: 'image_url', image_url: { url } });
  }

  // Every image failed to read, so the parts array is a text part and nothing
  // else — which is just the text, said in a more expensive way.
  if (parts.length === 1) return { content: text, dropped };

  return { content: parts, dropped };
}
