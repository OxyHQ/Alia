import { Platform, Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { File, Paths } from 'expo-file-system';

/**
 * Hand a Markdown document to the person, however this platform does that.
 *
 * On web that is a download: a `Blob` behind a temporary object URL, clicked
 * through an anchor that names the file. The URL is revoked once the click
 * has been dispatched — synchronously would race the browser reading it.
 *
 * On a phone the document is written to the CACHE directory (the system may
 * reclaim it, which is right for a file whose only purpose is to be handed
 * on) and offered through React Native's own share sheet: iOS's sheet takes a
 * file `url` and shares the `.md` itself, while Android's `Share.share` accepts
 * only `message`, so there the sheet carries the document's text. (`expo-sharing`
 * is a dependency and `save-image.ts` uses it to share an image as a file on
 * Android; a Markdown document is text, so the text is what is handed over.)
 */
export async function deliverMarkdownFile(
  filename: string,
  content: string,
  title: string,
): Promise<void> {
  if (Platform.OS === 'web') {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
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

  const file = new File(Paths.cache, filename);
  await file.write(content);
  await Share.share(Platform.OS === 'ios' ? { url: file.uri, title } : { message: content, title });
}

/** What became of a share link handed to the person. */
export type ShareLinkOutcome = 'shared' | 'copied' | 'dismissed';

/**
 * Hand a conversation's share link (`useShareConversation` → `share.url`, Alia's one shared page)
 * to the person, however this platform does that.
 *
 * On a phone it is React Native's share sheet: iOS takes the link as a `url`, Android only a
 * `message`, so there the text carries it. On web it is the browser's own share sheet where there
 * is one (`navigator.share`, most phones' browsers), and the clipboard everywhere else — a desktop
 * browser's sheet, where it exists, is a worse way to get a link into a chat than pasting it.
 * Closing the sheet is `dismissed`, not a failure; a sheet that cannot open at all falls back to
 * the clipboard.
 */
export async function deliverShareLink(
  url: string,
  title: string,
  text: string,
): Promise<ShareLinkOutcome> {
  if (Platform.OS !== 'web') {
    const result = await Share.share(
      Platform.OS === 'ios' ? { url, title, message: text } : { message: `${text}\n${url}`, title },
    );
    return result.action === Share.dismissedAction ? 'dismissed' : 'shared';
  }
  const touch =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;
  if (touch && typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ url, title, text });
      return 'shared';
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') return 'dismissed';
      // The sheet could not open (no user activation, a blocked frame): copy instead.
    }
  }
  await Clipboard.setStringAsync(url);
  return 'copied';
}
