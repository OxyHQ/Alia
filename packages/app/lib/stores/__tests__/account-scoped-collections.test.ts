import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Collections belong to the account that made them (#547).
 *
 * Folders, projects, favourites and pins used to live under one device-wide
 * AsyncStorage key, so a folder created under profile A was still in the
 * sidebar after switching to profile B — holding conversation ids B could not
 * open. Every store now reads and writes `<base>:<userId>`, empties itself the
 * moment the account changes, and discards a load that resolves after the
 * account changed again.
 *
 * AsyncStorage is replaced by an in-memory map whose reads can be held back on
 * demand: the race test needs A's read to resolve AFTER B has been bound,
 * which no real storage will do on cue.
 */

const storage = vi.hoisted(() => {
  const map = new Map<string, string>();
  /** Reads for these keys wait on `release` instead of resolving at once. */
  const held = new Map<string, Array<() => void>>();
  return {
    map,
    held,
    hold(key: string) {
      held.set(key, []);
    },
    release(key: string) {
      for (const resume of held.get(key) ?? []) resume();
      held.delete(key);
    },
  };
});

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => {
      const waiters = storage.held.get(key);
      if (waiters) await new Promise<void>((resolve) => waiters.push(resolve));
      return storage.map.get(key) ?? null;
    }),
    setItem: vi.fn(async (key: string, value: string) => {
      storage.map.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      storage.map.delete(key);
    }),
  },
}));

/**
 * Every test gets its own module instances: the stores are module singletons
 * and the legacy claim is decided once per process, which is exactly the
 * behaviour under test and must not leak between cases.
 */
async function freshStores() {
  vi.resetModules();
  const [folders, projects, favorites, pinned] = await Promise.all([
    import('../folders-store'),
    import('../projects-store'),
    import('../favorites-store'),
    import('../pinned-store'),
  ]);
  return {
    folders: folders.useFoldersStore,
    projects: projects.useProjectsStore,
    favorites: favorites.useFavoritesStore,
    pinned: pinned.usePinnedStore,
  };
}

const folderNames = (store: Awaited<ReturnType<typeof freshStores>>['folders']) =>
  store.getState().folders.map((f) => f.name);

beforeEach(() => {
  storage.map.clear();
  storage.held.clear();
  vi.clearAllMocks();
});

describe('folders across switched accounts', () => {
  it('shows B none of what A made, and gives it back to A on return', async () => {
    const { folders } = await freshStores();

    await folders.getState().loadFolders('user-a');
    await folders.getState().createFolder('Work');
    const workId = folders.getState().folders[0].id;
    await folders.getState().addConversationToFolder(workId, 'conv-1');
    expect(folders.getState().folders[0].conversationIds).toEqual(['conv-1']);

    await folders.getState().loadFolders('user-b');
    expect(folders.getState().folders).toEqual([]);

    await folders.getState().createFolder('Personal');
    expect(folderNames(folders)).toEqual(['Personal']);

    await folders.getState().loadFolders('user-a');
    expect(folderNames(folders)).toEqual(['Work']);
    expect(folders.getState().folders[0].conversationIds).toEqual(['conv-1']);

    // On disk they are two namespaces, and no unscoped key was written.
    expect([...storage.map.keys()].sort()).toEqual(['alia-folders:user-a', 'alia-folders:user-b']);
  });

  it('keeps the isolation across a reload', async () => {
    let stores = await freshStores();
    await stores.folders.getState().loadFolders('user-a');
    await stores.folders.getState().createFolder('Work');
    await stores.folders.getState().loadFolders('user-b');
    await stores.folders.getState().createFolder('Personal');

    stores = await freshStores();
    await stores.folders.getState().loadFolders('user-b');
    expect(folderNames(stores.folders)).toEqual(['Personal']);
    await stores.folders.getState().loadFolders('user-a');
    expect(folderNames(stores.folders)).toEqual(['Work']);
  });

  it('empties the list the moment the account changes, before the read lands', async () => {
    const { folders } = await freshStores();
    await folders.getState().loadFolders('user-a');
    await folders.getState().createFolder('Work');

    storage.hold('alia-folders:user-b');
    const loading = folders.getState().loadFolders('user-b');
    expect(folders.getState().folders).toEqual([]);
    storage.release('alia-folders:user-b');
    await loading;
    expect(folders.getState().folders).toEqual([]);
  });

  it('discards a slow load for A that resolves after switching to B', async () => {
    const { folders } = await freshStores();
    storage.map.set('alia-folders:user-a', JSON.stringify([{
      id: 'folder-1', name: 'Work', conversationIds: ['conv-1'], isExpanded: true,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }]));

    storage.hold('alia-folders:user-a');
    const slowLoadForA = folders.getState().loadFolders('user-a');
    await folders.getState().loadFolders('user-b');
    expect(folders.getState().folders).toEqual([]);

    storage.release('alia-folders:user-a');
    await slowLoadForA;

    // A's read finished under B's binding and went nowhere.
    expect(folders.getState().folders).toEqual([]);
    expect(storage.map.has('alia-folders:user-b')).toBe(false);
  });

  it('reads and persists nothing while signed out', async () => {
    const { folders } = await freshStores();
    storage.map.set('alia-folders', JSON.stringify([]));

    await folders.getState().loadFolders(null);
    await folders.getState().createFolder('Scratch');

    expect(folderNames(folders)).toEqual(['Scratch']);
    // Nothing was written, and the legacy key was not claimed by nobody.
    expect([...storage.map.keys()]).toEqual(['alia-folders']);
  });
});

describe('the legacy device-global key', () => {
  const LEGACY = [{
    id: 'folder-legacy', name: 'Before the upgrade', conversationIds: ['conv-old'], isExpanded: true,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }];

  it('moves once to the first account that loads, and is deleted', async () => {
    const { folders } = await freshStores();
    storage.map.set('alia-folders', JSON.stringify(LEGACY));

    await folders.getState().loadFolders('user-a');
    expect(folderNames(folders)).toEqual(['Before the upgrade']);
    expect(storage.map.has('alia-folders')).toBe(false);
    expect(storage.map.get('alia-folders:user-a')).toBe(JSON.stringify(LEGACY));

    await folders.getState().loadFolders('user-b');
    expect(folders.getState().folders).toEqual([]);

    // A later process, with the migration flag reset, finds no legacy key to
    // claim: the move happened exactly once.
    const again = await freshStores();
    await again.folders.getState().loadFolders('user-b');
    expect(again.folders.getState().folders).toEqual([]);
    await again.folders.getState().loadFolders('user-a');
    expect(folderNames(again.folders)).toEqual(['Before the upgrade']);
  });

  it('does not overwrite an account that already has its own data', async () => {
    const { folders } = await freshStores();
    storage.map.set('alia-folders', JSON.stringify(LEGACY));
    const own = [{ ...LEGACY[0], id: 'folder-own', name: 'Own' }];
    storage.map.set('alia-folders:user-a', JSON.stringify(own));

    await folders.getState().loadFolders('user-a');

    expect(folderNames(folders)).toEqual(['Own']);
    expect(storage.map.has('alia-folders')).toBe(false);
  });
});

describe('projects, favourites and pins', () => {
  it('scope their keys and the selected project the same way', async () => {
    const { projects, favorites, pinned } = await freshStores();

    await projects.getState().loadProjects('user-a');
    await projects.getState().createProject('Launch');
    const launchId = projects.getState().projects[0].id;
    await projects.getState().setCurrentProject(launchId);
    await favorites.getState().loadFavorites('user-a');
    await favorites.getState().toggleFavorite('conv-1');
    await pinned.getState().loadPinned('user-a');
    await pinned.getState().togglePin('conv-2');

    await projects.getState().loadProjects('user-b');
    await favorites.getState().loadFavorites('user-b');
    await pinned.getState().loadPinned('user-b');
    expect(projects.getState().projects).toEqual([]);
    expect(projects.getState().currentProjectId).toBeNull();
    expect(favorites.getState().isFavorite('conv-1')).toBe(false);
    expect(pinned.getState().isPinned('conv-2')).toBe(false);

    await projects.getState().loadProjects('user-a');
    await favorites.getState().loadFavorites('user-a');
    await pinned.getState().loadPinned('user-a');
    expect(projects.getState().projects.map((p) => p.name)).toEqual(['Launch']);
    expect(projects.getState().currentProjectId).toBe(launchId);
    expect(favorites.getState().isFavorite('conv-1')).toBe(true);
    expect(pinned.getState().isPinned('conv-2')).toBe(true);

    expect([...storage.map.keys()].sort()).toEqual([
      'alia-current-project:user-a',
      'alia-favorite-conversations:user-a',
      'alia-pinned-conversations:user-a',
      'alia-projects:user-a',
    ]);
  });

  it('migrate their legacy keys to the first account too', async () => {
    const { projects, favorites, pinned } = await freshStores();
    storage.map.set('alia-projects', JSON.stringify([{
      id: 'project-1', name: 'Old', conversationIds: [], isExpanded: true,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }]));
    storage.map.set('alia-current-project', 'project-1');
    storage.map.set('alia-favorite-conversations', JSON.stringify(['conv-1']));
    storage.map.set('alia-pinned-conversations', JSON.stringify(['conv-2']));

    await projects.getState().loadProjects('user-a');
    await favorites.getState().loadFavorites('user-a');
    await pinned.getState().loadPinned('user-a');

    expect(projects.getState().projects.map((p) => p.name)).toEqual(['Old']);
    expect(projects.getState().currentProjectId).toBe('project-1');
    expect(favorites.getState().favoriteConversationIds).toEqual(['conv-1']);
    expect(pinned.getState().pinnedConversationIds).toEqual(['conv-2']);
    expect([...storage.map.keys()].sort()).toEqual([
      'alia-current-project:user-a',
      'alia-favorite-conversations:user-a',
      'alia-pinned-conversations:user-a',
      'alia-projects:user-a',
    ]);
  });
});
