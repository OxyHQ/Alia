import type React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Personalization saves language, tone and voice only: no occupation, location, bio or interests.
 * Its Save and Cancel are the page header's (`SettingsPageActions`), never a row of the body.
 */

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
vi.mock('@oxy.so/bloom/settings-modal', async () =>
  hosts('SettingsCard', 'SettingsRow', 'SettingsPageActions'),
);
vi.mock('@oxy.so/bloom/settings-modal/rows', async () => hosts('SettingsSelect'));
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
      preferences: { language: 'es-ES', tone: 'friendly', voice: 'male', responseLength: 'short' },
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
  it('renders only language, length, voice and personality, and saves just those', async () => {
    await act(async () => {
      renderer = create(<PersonalizationSection />);
    });
    const tree = renderer!;
    expect(all(tree, 'SettingsRow').map((row) => row.props.label)).toEqual([
      'settings.aliaLanguage.title',
      'settings.responseLength.title',
      'settings.voicePreference.title',
      'personality',
    ]);
    expect(all(tree, 'SettingsTextField')).toHaveLength(0);
    expect(all(tree, 'Textarea')).toHaveLength(0);

    const actions = all(tree, 'SettingsPageActions')[0]!.props.actions as {
      key: string;
      onPress: () => void;
    }[];
    expect(actions.map((action) => action.key)).toEqual(['cancel', 'save']);
    await act(async () => actions.find((action) => action.key === 'save')!.onPress());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.test/memory/preferences');
    // The stored length goes back with the rest: the preferences are replaced as a whole.
    expect(JSON.parse(init.body)).toEqual({
      language: 'es-ES',
      tone: 'friendly',
      voice: 'male',
      responseLength: 'short',
    });
    expect(toastMock.success).toHaveBeenCalled();
  });

  it('offers the language of the person as the default, first, and saving it clears the choice', async () => {
    await act(async () => {
      renderer = create(<PersonalizationSection />);
    });
    const tree = renderer!;
    const select = all(tree, 'SettingsSelect').find(
      (node) => node.props.label === 'settings.aliaLanguage.title',
    )!;
    const items = select.props.items as { value: string; label: string }[];
    // The default is "no language chosen": the first option, with an empty value.
    expect(items[0]).toEqual({ value: '', label: 'settings.aliaLanguage.auto' });
    expect(items.slice(1).every((item) => item.value !== '')).toBe(true);
    // The stored choice is shown as it is, and picking the default empties it again.
    expect(select.props.value).toBe('es-ES');
    await act(async () => select.props.onChange(''));
    const actions = all(tree, 'SettingsPageActions')[0]!.props.actions as {
      key: string;
      onPress: () => void;
    }[];
    await act(async () => actions.find((action) => action.key === 'save')!.onPress());
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body)).toEqual({
      language: '',
      tone: 'friendly',
      voice: 'male',
      responseLength: 'short',
    });
  });

  it('offers a response length, none by default, and leaves it out of the save when none is chosen', async () => {
    await act(async () => {
      renderer = create(<PersonalizationSection />);
    });
    const tree = renderer!;
    const select = all(tree, 'SettingsSelect').find(
      (node) => node.props.label === 'settings.responseLength.title',
    )!;
    const items = select.props.items as { value: string; label: string }[];
    expect(items.map((item) => item.value)).toEqual(['', 'short', 'medium', 'long']);
    expect(select.props.value).toBe('short');
    await act(async () => select.props.onChange(''));
    const actions = all(tree, 'SettingsPageActions')[0]!.props.actions as {
      key: string;
      onPress: () => void;
    }[];
    await act(async () => actions.find((action) => action.key === 'save')!.onPress());
    const [, init] = fetchMock.mock.calls[0]!;
    // The stored set has no empty value, so "none" is the absence of the key.
    expect(JSON.parse(init.body)).toEqual({ language: 'es-ES', tone: 'friendly', voice: 'male' });
  });
});
