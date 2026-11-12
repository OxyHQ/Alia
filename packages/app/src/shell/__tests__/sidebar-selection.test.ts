import { describe, expect, it } from 'vitest';

import { selectedItemForPath } from '../sidebar-history';

/**
 * Which primary sidebar row reads as selected. The rows are routes, so the
 * route decides: its first segment, detail pages included. A chat is not a
 * row — it is selected in the tree — and a route the sidebar does not list
 * selects nothing rather than the nearest-looking row.
 */
describe('selectedItemForPath', () => {
  it.each([
    ['/tasks', 'tasks'],
    ['/skills/create', undefined],
    ['/shows/9', 'shows'],
    ['/notifications', 'notifications'],
  ])('%s selects %s', (path, key) => {
    expect(selectedItemForPath(path)).toBe(key);
  });

  it.each(['/', '/c/abc', '/settings/general', '/nate', '/agents'])('%s selects no row', (path) => {
    expect(selectedItemForPath(path)).toBeUndefined();
  });
});
