import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ROOT } from '@/shared/testing/app-root';

/**
 * The app has exactly ONE react-native-keyboard-controller `KeyboardProvider`:
 * the one `OxyProvider` mounts (its `KeyboardBoundary`).
 *
 * Every provider watches for a `<Modal>` to show, suspends its own keyboard
 * callback while it is up, and resumes it from `dialog.setOnDismissListener` —
 * and a dialog keeps only the LAST listener. With two providers, one stayed
 * suspended after the first Modal closed: on a Pixel 8a (Android 16), after the
 * model picker or the Oxy account/sign-in sheet had been open once, the
 * composer no longer rose with the keyboard until the app was restarted (#608,
 * `docs/native-validation.mdx`). Alia had a second provider of its own in
 * `app/_layout.tsx`, and Bloom's `BottomSheet` added a third inside its Modal
 * (removed upstream in Bloom). Nothing on web shows any of this.
 *
 * Read off the source: rendering the native providers here would be mocks of
 * the very thing under test.
 */

const strip = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === '__tests__' || name === 'testing') return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const require = createRequire(join(APP_ROOT, 'package.json'));
const packageRoot = (name: string) => dirname(require.resolve(`${name}/package.json`));

describe('one KeyboardProvider in the app', () => {
  it('Alia mounts none of its own', () => {
    const offenders = [...sourceFiles(join(APP_ROOT, 'app')), ...sourceFiles(join(APP_ROOT, 'src'))].filter(
      (file) => /\bKeyboardProvider\b/.test(strip(readFileSync(file, 'utf8'))),
    );
    expect(offenders).toEqual([]);
  });

  it('OxyProvider mounts the one', () => {
    const boundary = readFileSync(
      join(packageRoot('@oxy.so/services'), 'src/ui/components/KeyboardBoundary.native.tsx'),
      'utf8',
    );
    expect(strip(boundary)).toMatch(/<KeyboardProvider>/);
  });

  it("Bloom's sheet adds none inside its Modal", () => {
    const sheet = readFileSync(join(packageRoot('@oxy.so/bloom'), 'src/bottom-sheet/BottomSheet.tsx'), 'utf8');
    expect(strip(sheet)).not.toMatch(/KeyboardProvider/);
  });
});
