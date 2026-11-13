/**
 * Once per device and account: what this device filed before collections were the account's —
 * pins, favourites, folders and projects kept in its storage — joins the account
 * (`POST /v1/conversations/collections/import`, which merges by name), and the device keeps none of
 * it afterwards. Nothing to bring, nothing is sent.
 */

import { importCollections, type LocalCollections, useGemieApi } from '@gemies/sdk/runtime';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { gemieQueryKeys } from '@gemies/sdk/runtime';
import { AccountScopedKey } from '@/shared/state/account-scope';

/** The keys the device-local stores wrote; read once more to bring them over, then removed. */
const LEGACY = {
  pinned: new AccountScopedKey('alia-pinned-conversations'),
  favorites: new AccountScopedKey('alia-favorite-conversations'),
  folders: new AccountScopedKey('alia-folders'),
  projects: new AccountScopedKey('alia-projects'),
  currentProject: new AccountScopedKey('alia-current-project'),
};

interface LegacyCollection {
  name?: unknown;
  description?: unknown;
  icon?: unknown;
  color?: unknown;
  isFavorite?: unknown;
  isExpanded?: unknown;
  conversationIds?: unknown;
}

const ids = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((id): id is string => typeof id === 'string' && id !== '')
    : [];

function collections(raw: string | null): LocalCollections['folders'] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as LegacyCollection[];
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) =>
      typeof item?.name === 'string' && item.name.trim() !== ''
        ? [
            {
              name: item.name.trim().slice(0, 80),
              ...(typeof item.description === 'string' ? { description: item.description } : {}),
              ...(typeof item.icon === 'string' ? { icon: item.icon } : {}),
              ...(typeof item.color === 'string' ? { color: item.color } : {}),
              ...(typeof item.isFavorite === 'boolean' ? { isFavorite: item.isFavorite } : {}),
              ...(typeof item.isExpanded === 'boolean' ? { isExpanded: item.isExpanded } : {}),
              conversationIds: ids(item.conversationIds),
            },
          ]
        : [],
    );
  } catch {
    return [];
  }
}

function list(raw: string | null): string[] {
  if (!raw) return [];
  try {
    return ids(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** Bring this device's collections into the signed-in account, once. */
export function useImportLocalCollections(userId: string | null): void {
  const api = useGemieApi();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!userId) return;
    let current = true;
    const keys = Object.values(LEGACY);
    for (const key of keys) key.bind(userId);
    void (async () => {
      const local: LocalCollections = {
        pinned: list(await LEGACY.pinned.getItem()),
        favorites: list(await LEGACY.favorites.getItem()),
        folders: collections(await LEGACY.folders.getItem()),
        projects: collections(await LEGACY.projects.getItem()),
      };
      if (!current) return;
      const empty =
        local.pinned.length +
          local.favorites.length +
          local.folders.length +
          local.projects.length ===
        0;
      if (!empty) {
        const snapshot = await importCollections(api, local);
        if (!current) return;
        queryClient.setQueryData(gemieQueryKeys.collections, snapshot);
      }
      // Kept nowhere on the device any more: the account holds them.
      await Promise.all(keys.map((key) => key.removeItem()));
    })().catch(() => {
      // Left on the device; the next sign-in tries again.
    });
    return () => {
      current = false;
    };
  }, [userId, api, queryClient]);
}
