import { Platform, Share } from 'react-native';
import { File, Paths } from 'expo-file-system';

/**
 * Whether this platform can hand an image over as a FILE.
 *
 * Web downloads it and iOS offers it through the share sheet (which has "Save
 * Image"). Android's `Share.share` takes only a `message`, and `expo-sharing`
 * is not a dependency of this app (see `conversation-share.ts`), so there the
 * gallery draws no download action at all rather than one that shares a link
 * and calls it a download.
 */
export function canSaveImage(): boolean {
  return Platform.OS === 'web' || Platform.OS === 'ios';
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

/** `name` with an image extension, taken from a data URI's type or the URL's path when it has none. */
export function imageFilename(name: string, uri: string): string {
  const base = name.trim().replace(/[\\/:*?"<>|\n\r]+/g, ' ').slice(0, 80).trim() || 'image';
  if (/\.[a-z0-9]{2,4}$/i.test(base)) return base;
  const mime = /^data:([^;,]+)/i.exec(uri)?.[1]?.toLowerCase();
  const fromPath = /\.([a-z0-9]{2,4})(?:$|[?#])/i.exec(uri.startsWith('data:') ? '' : uri)?.[1];
  return `${base}.${(mime && EXTENSION_BY_MIME[mime]) ?? fromPath?.toLowerCase() ?? 'png'}`;
}

/**
 * Hand an image to the person as a file, named `filename`.
 *
 * On web the bytes are fetched into a `Blob` and clicked through an anchor
 * that names the file: an anchor's `download` attribute is ignored for a
 * cross-origin URL (the stored-media links are), so linking the URL itself
 * would open it instead. If the bytes cannot be read here (CORS), the image is
 * opened in a new tab, where the browser can still save it.
 *
 * On iOS it is written to the cache (a data URI decoded, a URL downloaded) and
 * offered through the share sheet.
 */
export async function saveImage(uri: string, filename: string): Promise<void> {
  if (Platform.OS === 'web') {
    let blob: Blob;
    try {
      const response = await fetch(uri);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      blob = await response.blob();
    } catch {
      window.open(uri, '_blank', 'noopener,noreferrer');
      return;
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }

  if (!canSaveImage()) throw new Error('Saving an image is not supported on this platform');
  const file = new File(Paths.cache, filename);
  const data = /^data:[^,]*;base64,(.*)$/s.exec(uri)?.[1];
  if (data !== undefined) {
    file.write(data, { encoding: 'base64' });
  } else {
    await File.downloadFileAsync(uri, file, { idempotent: true });
  }
  await Share.share({ url: file.uri, title: filename });
}
