import type React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Personalization saves language, tone and voice only: no occupation, location, bio or interests. */

const { hosts } = vi.hoisted(() => ({
  hosts: async (...names: string[]) => {
    const ReactModule = await import('react');
    return Object.fromEntries(
      names.map((name) => [
        name,
        ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
          ReactModule.createElement(name, props, children as React.ReactNode),
      ]),
    );
  },
}));

const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock('react-native', async () => hosts('View', 'Text'));
vi.mock('@oxy.so/bloom/settings-modal', async () => hosts('SettingsCard', 'SettingsRow'));
vi.mock('@oxy.so/bloom/settings-modal/rows', async () => hosts('SettingsSelect'));
vi.mock('@oxy.so/bloom/button-group', async () => hosts('ButtonGroup', 'ButtonGroupItem'));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: toastMock }));
vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({
    isAuthenticated: true,
    oxyServices: { session: { accessToken: 'token' } },
  }),
}));
vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/shared/api/generate-api-url', () => ({
  generateAPIUrl: (path: string) => `https://api.test${path}`,
}));
vi.mock('@/features/memory/runtime/use-user-data', async () => {
  const { useUserDataStore } = await import('@/features/memory/runtime/user-data-store');
  return { useUserData: () => ({ memory: useUserDataStore.getState().memory, loading: false }) };
});
vi.mock('@/features/settings/ui/personality-style-picker', () => ({
  usePersonalityStyleRow: ({ selectedStyle }: { selectedStyle: string }) => ({
    key: 'personality',
    label: 'personality',
    control: null,
    selectedStyle,
  }),
}));

const { PersonalizationSection } = await import('@/features/settings/ui/personalization-section');
const { useUserDataStore } = await import('@/features/memory/runtime/user-data-store');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const fetchMock = vi.fn();
let renderer: ReactTestRenderer | null = null;

const all = (tree: ReactTestRenderer, type: string): ReactTestInstance[] =>
  tree.root.findAll((node) => (node.type as unknown) === type);

beforeEach(() => {
  useUserDataStore.setState({
    memory: {
      settings: { recallEnabled: true },
      preferences: { language: 'es-ES', tone: 'friendly', voice: 'male' },
    },
  });
  fetchMock.mockReset().mockResolvedValue({
    ok: true,
    json: async () => ({ settings: { recallEnabled: true }, preferences: {} }),
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
  useUserDataStore.setState({ memory: null });
});

describe('PersonalizationSection', () => {
  it('renders only language, voice and personality, and saves just those', async () => {
    await act(async () => {
      renderer = create(<PersonalizationSection />);
    });
    const tree = renderer!;
    expect(all(tree, 'SettingsRow').map((row) => row.props.label)).toEqual([
      'settings.aliaLanguage.title',
      'settings.voicePreference.title',
      'personality',
      'settings.saveButton',
    ]);
    expect(all(tree, 'SettingsTextField')).toHaveLength(0);
    expect(all(tree, 'Textarea')).toHaveLength(0);

    const save = all(tree, 'ButtonGroupItem')[1]!;
    await act(async () => save.props.onPress());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.test/memory/preferences');
    expect(JSON.parse(init.body)).toEqual({ language: 'es-ES', tone: 'friendly', voice: 'male' });
    expect(toastMock.success).toHaveBeenCalled();
  });
});
