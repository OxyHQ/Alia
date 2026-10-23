/** Historical column vocabulary only; no runtime or API reads/writes app levels.
 * Retained until the post-cutover archival migration removes the legacy table.
 */
export const STORED_OXY_APP_LEVELS = ['read', 'act'] as const;
export type StoredOxyAppLevel = (typeof STORED_OXY_APP_LEVELS)[number];
