import { ALIA_WEB_ORIGIN } from './origins';

// Literal optional require stays directly in try for Metro's optional-peer resolver.
// This neutral subpath contains no React Native or GPU module imports.
let revision: string | undefined;
try {
  const companion = require('@oxy.so/bloom-avatar-native/runtime-revision');
  if (/^[a-f0-9]{64}$/.test(companion.AVATAR_RUNTIME_REVISION ?? '')) {
    revision = companion.AVATAR_RUNTIME_REVISION;
  }
} catch {
  // Hosts without the optional native companion keep Bloom's WebView fallback.
}
export const ALIA_CHARACTER_RUNTIME_URL = revision
  ? `${ALIA_WEB_ORIGIN}/bloom-character/releases/${revision}/runtime.mjs`
  : `${ALIA_WEB_ORIGIN}/bloom-character/runtime.mjs`;
