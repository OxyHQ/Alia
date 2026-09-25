import { Platform, Share } from 'react-native';
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
 * on) and offered through React Native's own share sheet. `expo-sharing` is
 * NOT a dependency of this app, so it is not used: iOS's sheet takes a file
 * `url` and shares the `.md` itself, while Android's `Share.share` accepts
 * only `message`, so there the sheet carries the document's text. Adding
 * `expo-sharing` is what would let Android share the file rather than its
 * contents.
 */
export async function deliverMarkdownFile(filename: string, content: string, title: string): Promise<void> {
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
  file.write(content);
  await Share.share(
    Platform.OS === 'ios'
      ? { url: file.uri, title }
      : { message: content, title },
  );
}
