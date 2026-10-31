/**
 * The avatar leaf entry: Alia's live avatar and what makes it react, without the chat.
 *
 * An app puts her on a button in its header (`AliaAvatarIcon`) and keeps the chat itself behind a
 * lazy import, so the SDK's conversation UI is not in the entry bundle just to draw a face. This
 * entry reaches the avatar, the activity store and its one socket, and nothing of the sheet, the
 * composer, the markdown renderer or the voice call (`check:entries` holds that).
 */
export { ALIA_AVATAR, AliaAvatar } from './components/AliaAvatar';
export type { AliaAvatarProps, AliaAvatarState } from './components/AliaAvatar';
export { AliaAvatarIcon } from './components/AliaAvatarIcon';
export { useAliaActivity } from './hooks/useAliaActivity';
export type { UseAliaActivityOptions } from './hooks/useAliaActivity';
