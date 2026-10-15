import { AccountScopedKey } from '@/shared/state/account-scope';

/**
 * The offline copy of the conversations, per account.
 *
 * It was one device-wide key, so a copy written while A's session was failing
 * (a 401 on save) was what B's sidebar fell back to on B's next 401 — A's
 * titles and messages under B's name (#608 §4). It is bound with the other
 * account-scoped stores in `app/(app)/_layout.tsx`, and handed to the SDK's
 * conversation runtime as its `offline` store; signed out it reads nothing and
 * writes nothing.
 */
export const offlineConversations = new AccountScopedKey('alia-conversations');
