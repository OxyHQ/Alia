import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The shortcuts must be heard from inside a text field. react-native-web's
 * TextInput stops every keydown from bubbling, so a listener on the document
 * never saw ⌘K typed in the composer — where a person's hands already are.
 * Listening on the window in the capture phase runs before the field does.
 */

const harness = vi.hoisted(() => ({ visible: false }));

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@oxy.so/bloom/command', () => ({
  Command: (props: { visible: boolean }) => {
    harness.visible = props.visible;
    return null;
  },
}));
vi.mock('@oxy.so/bloom/icons/RiBankCardLine', () => ({ RiBankCardLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiBookOpenLine', () => ({ RiBookOpenLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiBookShelfLine', () => ({ RiBookShelfLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiChat3Line', () => ({ RiChat3Line: () => null }));
vi.mock('@oxy.so/bloom/icons/RiChatNewLine', () => ({ RiChatNewLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiNotification3Line', () => ({ RiNotification3Line: () => null }));
vi.mock('@oxy.so/bloom/icons/RiSearchLine', () => ({ RiSearchLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiSettings3Line', () => ({ RiSettings3Line: () => null }));
vi.mock('@oxy.so/bloom/icons/RiSparklingLine', () => ({ RiSparklingLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiStarFill', () => ({ RiStarFill: () => null }));
vi.mock('@oxy.so/bloom/icons/RiTeamLine', () => ({ RiTeamLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiTimerLine', () => ({ RiTimerLine: () => null }));
vi.mock('@/features/chat/runtime/use-conversations', () => ({ useConversations: () => ({ data: undefined }) }));
vi.mock('@/shared/i18n/use-translation', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@/features/chat/runtime/ui-store', () => ({
  useUIStore: (select: (s: { toggleShortcutsDialog: () => void }) => unknown) =>
    select({ toggleShortcutsDialog: () => {} }),
}));
vi.mock('@/features/projects/runtime/favorites-store', () => ({
  useFavoritesStore: (select: (s: { favoriteConversationIds: string[] }) => unknown) =>
    select({ favoriteConversationIds: [] }),
}));

import { CommandPalette } from '@/shell/command-palette';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Listener = { type: string; fn: (e: KeyboardEvent) => void; capture: boolean };
let windowListeners: Listener[];
let documentListeners: Listener[];
const target = (list: Listener[]) => ({
  addEventListener: (type: string, fn: (e: KeyboardEvent) => void, options?: boolean | { capture?: boolean }) =>
    list.push({ type, fn, capture: options === true || (typeof options === 'object' && options.capture === true) }),
  removeEventListener: (type: string, fn: (e: KeyboardEvent) => void) => {
    const i = list.findIndex((l) => l.type === type && l.fn === fn);
    if (i >= 0) list.splice(i, 1);
  },
});

/**
 * A keydown typed in a field: capture-phase window listeners run, then the
 * field stops it, so nothing that listens by bubbling ever hears it.
 */
function typeInField(init: Partial<KeyboardEvent>) {
  const event = { preventDefault: () => {}, metaKey: false, ctrlKey: false, shiftKey: false, ...init } as KeyboardEvent;
  for (const l of windowListeners.filter((l) => l.type === 'keydown' && l.capture)) l.fn(event);
}

let renderer: ReactTestRenderer | null = null;
beforeEach(() => {
  windowListeners = [];
  documentListeners = [];
  vi.stubGlobal('window', target(windowListeners));
  vi.stubGlobal('document', target(documentListeners));
  harness.visible = false;
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe('the command palette’s shortcuts', () => {
  it('open and close it from inside a text field', async () => {
    await act(async () => {
      renderer = create(<CommandPalette />);
    });
    await act(async () => typeInField({ key: 'k', ctrlKey: true }));
    expect(harness.visible).toBe(true);
    await act(async () => typeInField({ key: 'k', metaKey: true }));
    expect(harness.visible).toBe(false);
  });
});
