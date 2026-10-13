/**
 * Reads a picked image (a `file://` URI on native, a `blob:` URL on web) into a
 * `data:` URL, the one form the chat API accepts as an `image_url` part without
 * the server having to reach the device.
 */
export async function imageUriToDataUrl(uri: string): Promise<string> {
  if (uri.startsWith('data:')) return uri;
  const blob = await (await fetch(uri)).blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the image'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}
