/**
 * The two origins the SDK talks to, defined once. Every URL it builds starts from one of them,
 * and `@alia.onl/sdk/csp` (`src/csp.ts`) derives the host's CSP from these same values, so an
 * origin the SDK uses is an origin it declares.
 */

/** Alia's API: `EXPO_PUBLIC_ALIA_API_URL`, then production. Chat, dictation, speech, voice. */
export const ALIA_API_URL = process.env.EXPO_PUBLIC_ALIA_API_URL ?? 'https://api.alia.onl';

/**
 * Alia's web app, which serves the files the SDK shares with every host: Bloom's character
 * runtime (`/bloom-character/`) and the voice call's worklets (`/sdk/voice-worklets/`), both
 * with CORS open (`packages/app/worker/index.js`).
 */
export const ALIA_WEB_ORIGIN = 'https://alia.onl';

/**
 * The one public page of a shared conversation, on Alia's web app, for every agent and every app
 * that embeds one (`docs/agent-embedding.md` §6). An app shares this URL rather than a page of its
 * own, so a link reads the same wherever it was minted.
 */
export function aliaSharedConversationUrl(token: string): string {
  return `${ALIA_WEB_ORIGIN}/shared/${encodeURIComponent(token)}`;
}
