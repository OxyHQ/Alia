/**
 * `expo-audio` on web, imported with the chat.
 *
 * On web this is a static import: a lazy `import()` would be an async chunk boundary inside the SDK,
 * and Metro hoists every module two async chunks share into `__common.js`, loaded at first paint —
 * an app that lazy-loads its Alia sheet would get the chat in its first paint. Native keeps the
 * lazy load (`./expo-audio.ts`); `scripts/check-entry-isolation.mjs` holds that web has no boundary.
 */

import * as ExpoAudio from 'expo-audio';

export const loadExpoAudio = async () => ExpoAudio;
