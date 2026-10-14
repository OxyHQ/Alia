import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));

vi.mock('@oxy.so/bloom/agent-avatar', () => ({
  AgentAvatar: (props: Record<string, unknown>) => {
    seen.props.push(props);
    return null;
  },
}));

import { AliaAvatar, type AliaAvatarProps } from '../../src/components/AliaAvatar';

const last = () => seen.props.at(-1) as Record<string, unknown>;

function render(props: AliaAvatarProps): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  act(() => {
    renderer = TestRenderer.create(<AliaAvatar {...props} />);
  });
  if (renderer === null) throw new Error('The avatar did not render.');
  return renderer;
}

describe('AliaAvatar', () => {
  beforeEach(() => {
    seen.props = [];
  });

  it("draws Alia's flower as a character: the blue_beret preset, hatless, in orchid", () => {
    render({ size: 40 });

    // The flower is `blue_beret` with the hat off and the paint changed; Bloom fills in the rest.
    expect(last().character).toEqual({ preset: 'blue_beret', accessory: 'none', color: 'orchid' });
    expect(last()).not.toHaveProperty('config');
    expect(last()).toMatchObject({ size: 40, label: 'Alia', interactive: false });
  });

  it('plays one working turn each time Alia starts thinking or working', () => {
    const renderer = render({ size: 40, state: 'idle' });
    expect(last().workingKey).toBe(0);

    act(() => renderer.update(<AliaAvatar size={40} state="thinking" />));
    expect(last().workingKey).toBe(1);

    act(() => renderer.update(<AliaAvatar size={40} state="working" />));
    // Thinking and working are one busy stretch: no second turn in the middle of it.
    expect(last().workingKey).toBe(1);

    act(() => renderer.update(<AliaAvatar size={40} state="writing" />));
    expect(last().workingKey).toBe(1);

    act(() => renderer.update(<AliaAvatar size={40} state="thinking" />));
    expect(last().workingKey).toBe(2);
  });

  it('forwards interaction and the reaction key to the engine', () => {
    render({ size: 56, interactive: true, reactionKey: 3 });

    expect(last()).toMatchObject({ interactive: true, reactionKey: 3 });
  });
});
