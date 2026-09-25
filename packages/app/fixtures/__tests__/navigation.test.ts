import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP = join(__dirname, '..', '..');
const read = (path: string) => readFileSync(join(APP, path), 'utf8');

/**
 * The perf harness switches conversations the way the sidebar does. With
 * `pushState` + `popstate` instead, the router finds no state record for the
 * entry, calls `resetRoot` with fresh keys and remounts the whole app —
 * `OxyProvider` and a new QueryClient included — so every switch "leaked" the
 * previous client's 30-minute gc timers (docs/runtime-baseline.mdx §9).
 */
describe('the workspace harness switches chats through the router', () => {
  it('the fixture page navigates with router.replace, as the sidebar opens a chat', () => {
    const page = read('fixtures/routes/(app)/__fixtures/[id].tsx');
    expect(page).toMatch(/navigate: \(id\) => router\.replace\(/);
    expect(read('src/shell/sidebar.tsx')).toMatch(/router\.replace\(`\/\(app\)\/c\/\$\{id\}`\)/);
  });

  it('the harness routes through that seam and never through popstate', () => {
    const harness = read('scripts/perf/workspace.mjs');
    expect(harness).toMatch(/window\.__aliaFixture\.navigate\(key\)/);
    expect(harness).not.toMatch(/new PopStateEvent/);
    expect(harness).not.toMatch(/history\.pushState/);
  });
});
