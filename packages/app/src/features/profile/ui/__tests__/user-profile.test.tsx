import type React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** `/@username` for a person: Bloom's AI profile card over their public Oxy account. */

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

vi.mock('react-native', async () => hosts('ScrollView', 'View'));
vi.mock('@oxy.so/bloom/ai-profile-card', async () => hosts('AiProfileCard'));
vi.mock('@oxy.so/bloom/typography', async () => hosts('Text'));
vi.mock('@oxy.so/core', () => ({
  getAccountDisplayName: (user: { name?: { full?: string } }) => user.name?.full ?? '',
}));
vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key, locale: 'en' }),
}));

const { UserProfile } = await import('@/features/profile/ui/user-profile');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;
const all = (type: string): ReactTestInstance[] =>
  renderer!.root.findAll((node) => (node.type as unknown) === type);

function mount(user: Record<string, unknown>) {
  act(() => {
    renderer = create(<UserProfile user={user as never} />);
  });
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe('UserProfile', () => {
  it('is the AI profile card of an identity: name, handle and picture, no number and no heatmap', () => {
    mount({
      username: 'maya',
      name: { full: 'Maya Collins' },
      avatar: 'file-1',
      bio: ' Designer ',
    });
    const card = all('AiProfileCard')[0]!;
    expect(card.props.name).toBe('Maya Collins');
    expect(card.props.handle).toBe('@maya');
    expect(card.props.avatarSource).toBe('file-1');
    expect(card.props.badge).toBeUndefined();
    expect(card.props).not.toHaveProperty('contributions');
    expect(card.props).not.toHaveProperty('cells');
    expect(all('Text')[0]!.props.children).toBe('Designer');
  });

  it('falls back to the username when the account has no name, and draws no bio when it has none', () => {
    mount({ username: 'maya' });
    expect(all('AiProfileCard')[0]!.props.name).toBe('maya');
    expect(all('Text')).toHaveLength(0);
  });

  it('badges an account that is not a person with what it is', () => {
    mount({ username: 'oxy', name: { full: 'Oxy' }, kind: 'organization' });
    expect(all('AiProfileCard')[0]!.props.badge).toBe('profile.kind.organization');
  });
});
