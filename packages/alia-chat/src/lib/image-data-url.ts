import { File } from 'expo-file-system';
import { Platform } from 'react-native';

/**
 * Reads a picked image into a `data:` URL, the one form the chat API accepts as an `image_url`
 * part without the server having to reach the device. The picker's URI means nothing off the
 * device: on web it is a `blob:` URL (a handle into this tab's memory), on native a `file://`
 * path, and sent as it is either arrives as a string the model cannot open.
 *
 * Web reads the blob back; native reads the file with `expo-file-system`, as the Alia app does.
 */
export async function imageUriToDataUrl(uri: string, mimeType?: string): Promise<string> {
  if (uri.startsWith('data:')) return uri;
  if (Platform.OS !== 'web') {
    // The `File` API: the legacy `readAsStringAsync` from the package root throws at runtime.
    const base64 = await new File(uri).base64();
    return `data:${mimeType || 'image/jpeg'};base64,${base64}`;
  }
  const blob = await (await fetch(uri)).blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the image'));
    reader.onload = () => {
      const result = String(reader.result);
      // `readAsDataURL` stamps the blob's own type; it is only octet-stream when the blob has
      // none, and then the picker's type is the better guess.
      resolve(
        mimeType && result.startsWith('data:application/octet-stream')
          ? result.replace('data:application/octet-stream', `data:${mimeType}`)
          : result,
      );
    };
    reader.readAsDataURL(blob);
  });
}
