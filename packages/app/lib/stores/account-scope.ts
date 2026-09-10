import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * An AsyncStorage key that belongs to ONE signed-in account.
 *
 * Folders, projects, favourites and pins are device-local metadata about
 * conversations, and the conversations themselves belong to an account. The
 * stores used to persist them under a single device-wide key, so a folder made
 * under profile A stayed in the sidebar after switching to profile B, listing
 * conversation ids B could not open (#547). Every collection now reads and
 * writes `<base>:<userId>`, and the layout re-binds each store when the
 * signed-in user changes.
 *
 * ## Signed out
 *
 * Nobody is signed in, so there is no namespace to read. The key is unbound,
 * `getItem` answers nothing and `setItem` persists nothing — the in-memory
 * store is empty and stays in memory. No `anonymous` namespace: the sidebar
 * cannot list conversations without an account, so there is nothing for a
 * folder to hold, and a namespace that never has content is just a place for
 * stale ids to hide.
 *
 * ## The legacy device-global key
 *
 * The old unscoped `<base>` is migrated ONCE, to the FIRST account that binds
 * after the upgrade — in practice the person who was using the device — and
 * then deleted. Copying it into every account would give profile B the folders
 * this change exists to take away from it; dropping it would throw away the
 * organisation the device's owner built. The claim is decided synchronously
 * per process (`legacyClaimed`) so two loads racing through here cannot both
 * take it, and the legacy key is removed only after the scoped copy is
 * written, so a write that fails midway leaves the data where it was.
 *
 * ## Stale loads
 *
 * `bind` hands back a token; a load that resolves after the store was bound to
 * a different account compares its token with `isCurrent` and discards what it
 * read, so a slow read for A cannot land in B's sidebar.
 */
export class AccountScopedKey {
  private userId: string | null = null;
  private generation = 0;
  private legacyClaimed = false;

  constructor(private readonly base: string) {}

  /** Bind to an account, or to nobody. Returns the token `isCurrent` checks. */
  bind(userId: string | null): number {
    this.userId = userId;
    this.generation += 1;
    return this.generation;
  }

  /** The token of the current binding, for guarding a write's completion. */
  get token(): number {
    return this.generation;
  }

  isCurrent(token: number): boolean {
    return token === this.generation;
  }

  /** The account this key is bound to, `null` while signed out. */
  get account(): string | null {
    return this.userId;
  }

  keyFor(userId: string): string {
    return `${this.base}:${userId}`;
  }

  /** The persisted key for the bound account, `null` while signed out. */
  get key(): string | null {
    return this.userId ? this.keyFor(this.userId) : null;
  }

  async getItem(): Promise<string | null> {
    const key = this.key;
    if (!key) return null;
    const scoped = await AsyncStorage.getItem(key);
    return this.claimLegacy(key, scoped);
  }

  async setItem(value: string): Promise<void> {
    const key = this.key;
    if (!key) return;
    await AsyncStorage.setItem(key, value);
  }

  async removeItem(): Promise<void> {
    const key = this.key;
    if (!key) return;
    await AsyncStorage.removeItem(key);
  }

  /**
   * Move the device-global value under `key` if that account has nothing yet,
   * and delete it either way. See "The legacy device-global key" above.
   */
  private async claimLegacy(key: string, scoped: string | null): Promise<string | null> {
    if (this.legacyClaimed) return scoped;
    this.legacyClaimed = true;
    const legacy = await AsyncStorage.getItem(this.base);
    if (legacy === null) return scoped;
    if (scoped === null) await AsyncStorage.setItem(key, legacy);
    await AsyncStorage.removeItem(this.base);
    return scoped ?? legacy;
  }
}
