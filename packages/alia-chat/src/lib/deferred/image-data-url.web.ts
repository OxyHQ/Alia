/**
 * The attachment reader on web, imported with the runtime.
 *
 * On web this is a static import: a lazy `import()` would be an async chunk boundary inside the SDK,
 * and Metro hoists every module two async chunks share into `__common.js`, loaded at first paint —
 * an app that lazy-loads its Alia sheet would get the chat in its first paint. Native keeps the
 * lazy load (`./image-data-url.ts`); `scripts/check-entry-isolation.mjs` holds that web has no boundary.
 */

import * as ImageDataUrl from '../image-data-url';

export const loadImageDataUrl = async () => ImageDataUrl;
