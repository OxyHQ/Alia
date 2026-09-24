/**
 * The language to recognize when the caller names none.
 *
 * The browser's own language on web; the runtime's resolved locale on native
 * (Hermes implements `Intl`); `en-US` when neither answers. An app should pass
 * its UI locale instead — the Alia app does — because a person who chose
 * Spanish in the app expects to be understood in Spanish whatever the device
 * is set to.
 */
export function defaultSpeechLanguage(): string {
  const browser = globalThis.navigator?.language;
  if (typeof browser === 'string' && browser !== '') return browser;
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().locale;
    if (resolved) return resolved;
  } catch {
    // No Intl on this runtime.
  }
  return 'en-US';
}
