import { toast } from '@oxy.so/bloom/toast';
import * as Clipboard from 'expo-clipboard';
import type { Translate } from './copy';

/**
 * Copy `text`, and say which happened.
 *
 * The result is the clipboard's own: `setStringAsync` resolves `false` on web when the browser
 * refuses (no permission, no focus, an insecure origin) and rejects on native when the module is
 * missing. Either way the answer is `false` and an error toast, and Bloom's copy button, which
 * confirms only on `true`, stays a copy glyph instead of announcing "Copied!" over nothing.
 */
export async function copyText(text: string, t: Translate): Promise<boolean> {
  let copied: boolean;
  try {
    copied = (await Clipboard.setStringAsync(text)) !== false;
  } catch {
    copied = false;
  }
  if (copied) toast.success(t('chat.copiedToClipboard'));
  else toast.error(t('chat.copyFailed'));
  return copied;
}
