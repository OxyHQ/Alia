import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Twelve packages left the app manifest, and stay gone.
 *
 * They were removed by an import-based audit (#608 §11) that checked
 * every manifest entry against the specifiers the source really imports AND
 * against the mechanisms that reach a package without one — optional peers of
 * `@oxy.so/bloom` and `@oxy.so/services`, Expo config plugins named as strings
 * in `app.json`, metro/babel/postcss config, autolinked native modules, and
 * `.web`/`.native` forks. Nothing pointed at any of these twelve.
 *
 * The gate exists because the failure mode is silent in both directions. Adding
 * one back costs install time and a native module nobody calls; importing one
 * that is no longer declared resolves today only by accident of hoisting, and
 * breaks whenever the tree flattens differently. Either way nothing fails
 * loudly, so "these are not reachable" is asserted rather than remembered.
 *
 * Three of them looked reachable and were not, which is the part worth keeping
 * honest: `event-target-shim` is vendored inside `@livekit/react-native-webrtc`
 * (`./vendor/event-target-shim`) and declared as a peer by nobody; `expo-speech`
 * survives only in a stale comment in `metro.config.js`, because TTS runs
 * through `useTTS` in `@alia.onl/sdk` on top of `expo-audio`; and
 * `prettier-plugin-tailwindcss` has no prettier config anywhere in the repo to
 * load it, so it never activated.
 */

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Split so the gate does not match ITSELF: a bare listing of the names would
 * make this file its own first offender, and the walker below reads every
 * source file including this one.
 */
const REMOVED = [
  ['@expo/html', 'elements'],
  ['@radix-ui/react-scroll', 'area'],
  ['@react-native-community/', 'hooks'],
  ['event-target-', 'shim'],
  ['expo-', 'speech'],
  ['prettier-plugin-', 'tailwindcss'],
  ['react-native-syntax-', 'highlighter'],
  ['react-native-view-', 'shot'],
  ['zustand-', 'persist'],
  ['@babel/plugin-transform-react-', 'jsx'],
  ['es', 'build'],
  ['patch-', 'package'],
].map((parts) => parts.join(''));

/** Every source file of the app, minus the installed packages and this gate. */
function sources(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
        continue;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(entry.name) && path !== fileURLToPath(import.meta.url)) {
        found.push(path);
      }
    }
  };
  walk(APP);
  return found;
}

/**
 * An IMPORT of the package, not a mention of it. Prose may still explain what
 * was removed and why — `metro.config.js` still names `expo-speech` in a
 * comment — but a specifier that Metro would resolve may not exist.
 */
function importsOf(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:from|import|require\\(|require\\.resolve\\()\\s*['"]${escaped}(?:/[^'"]*)?['"]`);
}

describe('the dependencies the audit removed', () => {
  it('are absent from the app manifest', () => {
    const manifest = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const declared = new Set([
      ...Object.keys(manifest.dependencies),
      ...Object.keys(manifest.devDependencies),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ]);

    // Positive control on the read: an empty manifest would satisfy the
    // assertion below without proving anything.
    expect(declared.size).toBeGreaterThan(50);

    expect(REMOVED.filter((name) => declared.has(name))).toEqual([]);
  });

  it('are imported by nothing that runs', () => {
    const files = sources();
    // Positive control on the walker: an empty list would satisfy every
    // assertion below it without reading a single file.
    expect(files.length).toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const path of files) {
      const source = readFileSync(path, 'utf8');
      for (const name of REMOVED) {
        if (importsOf(name).test(source)) offenders.push(`${relative(APP, path)} -> ${name}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('would catch a reference if one came back', () => {
    // The same predicate against the thing it exists to reject, and against the
    // comment it must tolerate.
    const reintroduced = `import TrackPlayer from '${REMOVED[4]}';`;
    const merelyMentioned = `// TTS on web used to go through ${REMOVED[4]}.`;

    expect(importsOf(REMOVED[4]).test(reintroduced)).toBe(true);
    expect(importsOf(REMOVED[4]).test(merelyMentioned)).toBe(false);
  });
});
