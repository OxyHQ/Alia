import { AccountScopedKey } from '@/shared/state/account-scope';
import { create } from 'zustand';

/**
 * Which space folders the person has closed in the sidebar. Membership is the server's; whether a
 * folder is open is a device-local preference, kept per account exactly like the folders' own
 * (`AccountScopedKey`: the layout re-binds it when the user changes, a slow read for the previous
 * account is discarded). A folder is open until closed, so only the closed ones are stored.
 */
const storage = new AccountScopedKey('alia-spaces-closed');

interface SpacesOpenState {
  /** Ids of the spaces whose folder is closed. */
  closedIds: string[];
  loadSpacesOpen: (userId: string | null) => Promise<void>;
  setSpaceOpen: (spaceId: string, open: boolean) => Promise<void>;
}

export const useSpacesOpenStore = create<SpacesOpenState>((set, get) => ({
  closedIds: [],

  loadSpacesOpen: async (userId) => {
    const token = storage.bind(userId);
    set({ closedIds: [] });
    if (!userId) return;
    try {
      const stored = await storage.getItem();
      if (!storage.isCurrent(token)) return;
      const parsed: unknown = stored ? JSON.parse(stored) : [];
      set({
        closedIds: Array.isArray(parsed)
          ? parsed.filter((id): id is string => typeof id === 'string')
          : [],
      });
    } catch (error) {
      console.error('Error loading the closed spaces:', error);
    }
  },

  setSpaceOpen: async (spaceId, open) => {
    const closed = get().closedIds.filter((id) => id !== spaceId);
    const closedIds = open ? closed : [...closed, spaceId];
    const token = storage.token;
    try {
      await storage.setItem(JSON.stringify(closedIds));
    } catch (error) {
      console.error('Error saving the closed spaces:', error);
    }
    if (storage.isCurrent(token)) set({ closedIds });
  },
}));
