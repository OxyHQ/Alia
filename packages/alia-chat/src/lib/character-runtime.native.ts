import { AVATAR_RUNTIME_REVISION } from '@oxy.so/bloom/agent-avatar/runtime-revision';
import { ALIA_WEB_ORIGIN } from './origins';

// Bloom owns both the bundled native engine and its immutable hosted asset revision.
export const ALIA_CHARACTER_RUNTIME_URL = `${ALIA_WEB_ORIGIN}/bloom-character/releases/${AVATAR_RUNTIME_REVISION}/runtime.mjs`;
