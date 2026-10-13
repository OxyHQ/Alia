import { Platform } from 'react-native';

/**
 * Where Bloom's 3D character runtime (`AgentAvatar`) is served from.
 *
 * Web loads it from its own origin. Native avatars run inside a WebView, which needs an
 * absolute URL a device can reach, so they take it from the production web deployment,
 * which serves `public/bloom-character/` (see `scripts/setup-character-runtime.mjs`).
 */
export const CHARACTER_RUNTIME_URL =
  Platform.OS === 'web'
    ? '/bloom-character/runtime.mjs'
    : 'https://alia.onl/bloom-character/runtime.mjs';
