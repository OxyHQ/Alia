import type React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({
  avatar: [] as Array<Record<string, unknown>>,
  provider: [] as Array<Record<string, unknown>>,
  state: 'idle',
}));

vi.mock('@oxy.so/bloom/agent-avatar', () => ({
  AgentAvatar: () => null,
  AgentAvatarProvider: ({ children, ...props }: { children: React.ReactNode }) => {
    seen.provider.push(props);
    return <>{children}</>;
  },
}));
vi.mock('@oxy.so/bloom/avatar', () => ({
  Avatar: (props: Record<string, unknown>) => {
    seen.avatar.push(props);
    return null;
  },
}));
vi.mock('../../src/hooks/useAliaActivity', () => ({ useAliaActivity: () => seen.state }));

import { ALIA_AVATAR } from '../../src/avatar';
import { AliaAvatarProvider } from '../../src/components/AliaAvatarProvider';
import { AliaAvatarIcon } from '../../src/components/AliaAvatarIcon';
import { ALIA_AVATAR_STILL, ALIA_AVATAR_STILL_OF } from '../../src/lib/alia-avatar-still.generated';
import { ALIA_CHARACTER_RUNTIME_URL } from '../../src/lib/character-runtime';

describe('AliaAvatarIcon', () => {
  beforeEach(() => {
    seen.avatar = [];
    seen.provider = [];
    seen.state = 'idle';
  });

  it("draws Alia's character at the icon size, with her still made ahead of time, under its own runtime provider", () => {
    act(() => {
      TestRenderer.create(<AliaAvatarIcon width={24} height={24} fill="#fff" />);
    });
    expect(seen.provider.at(-1)).toMatchObject({ runtimeUrl: ALIA_CHARACTER_RUNTIME_URL });
    expect(seen.avatar.at(-1)).toMatchObject({
      character: ALIA_AVATAR,
      characterStill: { uri: ALIA_AVATAR_STILL },
      size: 24,
      activity: 'idle',
      alt: 'Alia',
    });
    // Never a pressable of its own: the button keeps the press.
    expect(seen.avatar.at(-1)).not.toHaveProperty('onPress');
  });

  it('keeps the explicit chat runtime URL for nested icons', () => {
    const runtimeUrl = 'https://host.test/releases/pinned/runtime.mjs';
    act(() => {
      TestRenderer.create(
        <AliaAvatarProvider runtimeUrl={runtimeUrl}>
          <AliaAvatarIcon />
        </AliaAvatarProvider>,
      );
    });
    expect(seen.provider).toHaveLength(2);
    expect(seen.provider.every((value) => value.runtimeUrl === runtimeUrl)).toBe(true);
  });

  it.each([
    ['thinking', 'working'],
    ['working', 'working'],
    ['writing', 'idle'],
    ['idle', 'idle'],
  ])('goes live while Alia is busy: %s -> %s', (state, activity) => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<AliaAvatarIcon width={20} />);
    });
    seen.state = state;
    act(() => renderer.update(<AliaAvatarIcon width={20} />));
    expect(seen.avatar.at(-1)).toMatchObject({ activity });
  });

  it('has a default size when the button gives none', () => {
    act(() => {
      TestRenderer.create(<AliaAvatarIcon />);
    });
    expect(seen.avatar.at(-1)).toMatchObject({ size: 20 });
  });
});

describe("Alia's still", () => {
  it('was drawn from the character she is now: change ALIA_AVATAR, run render:avatar-still', () => {
    expect(ALIA_AVATAR_STILL_OF).toEqual(ALIA_AVATAR);
  });

  it('is a square PNG of 128 px (64 at 2x), small enough to ship in the entry bundle', () => {
    expect(ALIA_AVATAR_STILL.startsWith('data:image/png;base64,')).toBe(true);
    const png = Buffer.from(ALIA_AVATAR_STILL.slice('data:image/png;base64,'.length), 'base64');
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([128, 128]);
    expect(png.length).toBeLessThan(32 * 1024);
  });
});
