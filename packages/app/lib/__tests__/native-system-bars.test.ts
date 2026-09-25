import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Android draws Alia edge to edge (`edgeToEdgeEnabled` in the generated
 * project), so the status bar lies over the app and two things are the app's
 * job. Neither shows on web, where every inset is zero and there is no bar, so
 * nothing but a device notices when they go — found on the emulator
 * (`docs/native-validation.mdx`):
 *
 * - The bar's icons: with no `<StatusBar>` they stayed light over Alia's light
 *   surface, and the clock and battery vanished into it.
 * - The top inset: Bloom's `AiChatShell` takes no safe area, and the chat
 *   routes took none either, so the frame, the header's menu button and the
 *   drawer started under the bar. The system takes a touch there: the menu
 *   button did nothing to a tap on its top two thirds.
 *
 * Both live in two layouts, so this reads the layouts.
 */

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string) =>
  readFileSync(join(APP, path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('the system bars on a device', () => {
  it('draws the status bar icons for the theme Alia resolved, not for the OS', () => {
    const root = read('app/_layout.tsx');
    expect(root).toMatch(/import \{ StatusBar \} from 'expo-status-bar'/);
    expect(root).toMatch(/<StatusBar style=\{isDarkColorScheme \? 'light' : 'dark'\} \/>/);
  });

  it('puts the whole shell below the status bar once, and no page adds it again', () => {
    const shell = read('app/(app)/_layout.tsx');
    expect(shell).toMatch(/<View style=\{\{ flex: 1, paddingTop: insets\.top \}\}>\{shell\}<\/View>/);
    // A page padding itself as well would sit a status bar lower than the chat.
    expect(shell).not.toMatch(/contentStyle:[^}]*paddingTop/);
  });
});
