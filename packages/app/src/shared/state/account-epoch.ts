/**
 * Which signed-in account the app's in-memory data currently belongs to, as a
 * number that only ever grows.
 *
 * A read that writes its answer into a store as a side effect — the memory
 * document, the library, the shows list — cannot be un-sent when the account
 * changes, and axios has no idea the person it was asking for has gone. So
 * such a read takes the epoch before it awaits and writes only if the epoch is
 * still the same afterwards: a slow answer for A that lands after the switch
 * to B, or after signing out, is dropped instead of repopulating the screen
 * (#608 §4).
 *
 * Advanced by `resetAccountSession` (`src/shell/account-lifecycle.ts`) and by nothing
 * else.
 */
let epoch = 0;

export function currentAccountEpoch(): number {
  return epoch;
}

export function isCurrentAccountEpoch(taken: number): boolean {
  return taken === epoch;
}

export function advanceAccountEpoch(): void {
  epoch += 1;
}
