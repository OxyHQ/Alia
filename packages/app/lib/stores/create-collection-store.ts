import { AccountScopedKey } from "./account-scope";

/**
 * Base interface for items managed by a collection store.
 */
export interface CollectionItem {
  id: string;
  name: string;
  icon?: string;
  color?: string;
  conversationIds: string[];
  isExpanded: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const COLORS = [
  "#3b82f6", "#8b5cf6", "#ec4899", "#f59e0b",
  "#10b981", "#06b6d4", "#f97316", "#ef4444",
];

export function getRandomColor(): string {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

export function getRandomIcon(icons: string[]): string {
  return icons[Math.floor(Math.random() * icons.length)];
}

/**
 * Helper for AsyncStorage-backed collection CRUD operations.
 * Extracts the duplicated load/save/create-item pattern
 * shared by folders-store and projects-store.
 *
 * The key is account-scoped: the store binds `storage` to the signed-in user
 * before loading, and `load`/`save` read and write that account's namespace
 * only (or nothing at all while signed out). See `AccountScopedKey`.
 */
export class CollectionPersister<T extends CollectionItem> {
  readonly storage: AccountScopedKey;

  constructor(
    storageKey: string,
    private idPrefix: string,
    private icons: string[],
  ) {
    this.storage = new AccountScopedKey(storageKey);
  }

  async load(): Promise<T[]> {
    const data = await this.storage.getItem();
    if (!data) return [];
    return JSON.parse(data).map((item: any) => ({
      ...item,
      createdAt: new Date(item.createdAt),
      updatedAt: new Date(item.updatedAt),
    }));
  }

  async save(items: T[]): Promise<void> {
    await this.storage.setItem(JSON.stringify(items));
  }

  newItem(name: string, extra?: Partial<T>): T {
    return {
      id: `${this.idPrefix}-${Date.now()}`,
      name,
      icon: extra?.icon || getRandomIcon(this.icons),
      color: getRandomColor(),
      conversationIds: [],
      isExpanded: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...extra,
    } as T;
  }

  updateIn(items: T[], id: string, updates: Partial<T>): T[] {
    return items.map((item) =>
      item.id === id ? { ...item, ...updates, updatedAt: new Date() } : item
    );
  }

  addConversation(items: T[], itemId: string, conversationId: string): T[] {
    return items.map((item) => {
      if (item.id === itemId && !item.conversationIds.includes(conversationId)) {
        return {
          ...item,
          conversationIds: [...item.conversationIds, conversationId],
          updatedAt: new Date(),
        };
      }
      return item;
    });
  }

  removeConversation(items: T[], itemId: string, conversationId: string): T[] {
    return items.map((item) => {
      if (item.id === itemId) {
        return {
          ...item,
          conversationIds: item.conversationIds.filter((id) => id !== conversationId),
          updatedAt: new Date(),
        };
      }
      return item;
    });
  }
}
