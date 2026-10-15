import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({
  avatar: [] as Array<Record<string, unknown>>,
  provider: [] as Array<Record<string, unknown>>,
  state: 'idle',
}));

vi.mock('@oxy.so/bloom/agent-avatar', () => ({
  AgentAvatar: (props: Record<string, unknown>) => {
    seen.avatar.push(props);
    return null;
  },
  AgentAvatarProvider: ({ children, ...props }: { children: React.ReactNode }) => {
    seen.provider.push(props);
    return <>{children}</>;
  },
}));
vi.mock('../../src/hooks/useAliaActivity', () => ({ useAliaActivity: () => seen.state }));

import { AliaAvatarIcon } from '../../src/components/AliaAvatarIcon';
import { ALIA_CHARACTER_RUNTIME_URL } from '../../src/lib/character-runtime';

describe('AliaAvatarIcon', () => {
  beforeEach(() => {
    seen.avatar = [];
    seen.provider = [];
    seen.state = 'idle';
  });

  it("draws Alia's avatar at the icon size under its own runtime provider, not interactive", () => {
    act(() => {
      TestRenderer.create(<AliaAvatarIcon width={24} height={24} fill="#fff" />);
    });
    expect(seen.provider.at(-1)).toMatchObject({ runtimeUrl: ALIA_CHARACTER_RUNTIME_URL });
    expect(seen.avatar.at(-1)).toMatchObject({ size: 24, interactive: false, portrait: false });
  });

  it('plays a working turn when the activity says Alia is working', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<AliaAvatarIcon width={20} />);
    });
    expect(seen.avatar.at(-1)).toMatchObject({ workingKey: 0 });
    seen.state = 'working';
    act(() => renderer.update(<AliaAvatarIcon width={20} />));
    expect(seen.avatar.at(-1)).toMatchObject({ workingKey: 1 });
  });

  it('has a default size when the button gives none', () => {
    act(() => {
      TestRenderer.create(<AliaAvatarIcon />);
    });
    expect(seen.avatar.at(-1)).toMatchObject({ size: 20 });
  });
});
