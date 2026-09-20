import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

/**
 * Alia's sky survives the move into Bloom's container.
 *
 * #608 names `AmbientField` non-negotiable twice: the brand gradient, its
 * palette, and the way it swells with capture and playback. It used to be a
 * SIBLING rendered before the message list — which only worked because Alia
 * owned the whole column and could decide what sat under what.
 *
 * Bloom's `AiChatContainer` paints its own `background-secondary` on its root,
 * so a sibling would have been painted over. `background` is the contract that
 * resolves it (Bloom 3.3.0, added for this): a node drawn above the
 * container's surface and below every turn, header and composer.
 *
 * Four properties, and each one is how the gradient dies if it is wrong:
 *
 * 1. **It is passed to Bloom's own slot**, not stacked by Alia. A gradient
 *    rendered as a sibling again is the bug this replaced.
 * 2. **It is BEHIND the turns.** A background drawn last covers the
 *    conversation; in a tree, "behind" means it comes first.
 * 3. **It reaches the field's own props.** The audio reactivity is the half
 *    #608 §3.1 cares most about — a field that renders but never hears the
 *    call is a still image of the thing that was meant to be preserved.
 * 4. **The composer and thread still arrive**, because a background that
 *    swallowed its siblings would pass 1-3 and show an empty chat.
 *
 * Bloom's container is stubbed at its module boundary rather than mounted: the
 * `ai-chat` barrel drags the overlay and styled-primitive graph and the whole
 * native Expo surface under it, and what is being asserted here is what Alia
 * HANDS Bloom, which is Alia's half of the contract. Where mounting a real
 * Bloom component is itself the subject, it is mounted — see
 * `message-block-boundary.test.tsx`.
 */

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    ReactModule.createElement(name, props, children);
  return {
    View: host('View'),
    Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
  };
});

vi.mock('@/lib/keyboard', async () => {
  const ReactModule = await import('react');
  return {
    KeyboardAvoidingView: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('KeyboardAvoidingView', props, children),
  };
});

vi.mock('@/components/ambient-field', async () => {
  const ReactModule = await import('react');
  return {
    AmbientField: (props: Record<string, unknown>) => ReactModule.createElement('AmbientField', props),
  };
});

/**
 * The stub renders `background` first and `children` after it, which is the
 * order Bloom documents and draws. Getting that order wrong here would make
 * the test agree with a broken implementation.
 */
vi.mock('@oxy.so/bloom/ai-chat', async () => {
  const ReactModule = await import('react');
  return {
    AiChatContainer: ({ background, children, composer, header, ...props }: Record<string, any>) =>
      ReactModule.createElement(
        'AiChatContainer',
        props,
        background,
        header,
        children,
        composer,
      ),
  };
});

import { ChatWorkspace } from '@/components/chat/chat-workspace';

function render(over: Record<string, unknown> = {}) {
  let renderer: any;
  act(() => {
    renderer = create(
      React.createElement(ChatWorkspace, {
        title: 'A chat',
        ambient: { intensity: 0.8, agentState: 'speaking', isDarkMode: true },
        children: React.createElement('TheTurns'),
        composer: React.createElement('TheComposer'),
        ...over,
      } as any),
    );
  });
  return renderer;
}

describe('the ambient field in Bloom\'s container', () => {
  it('goes through Bloom\'s background slot, not beside it', () => {
    const renderer = render();
    const container = renderer.root.findByType('AiChatContainer');

    // One field, and it is inside the container rather than stacked around it.
    expect(container.findAllByType('AmbientField')).toHaveLength(1);
  });

  it('is drawn before the turns, which is what "behind" means in a tree', () => {
    const renderer = render();
    const container = renderer.root.findByType('AiChatContainer');

    const order = container.findAll(
      (node: any) => node.type === 'AmbientField' || node.type === 'TheTurns',
      { deep: true },
    ).map((node: any) => node.type);

    expect(order).toEqual(['AmbientField', 'TheTurns']);
  });

  it('carries the audio reactivity through to the field', () => {
    const renderer = render({
      ambient: { intensity: 0.42, agentState: 'listening', isDarkMode: false },
    });

    const field = renderer.root.findByType('AmbientField');
    expect(field.props).toMatchObject({
      intensity: 0.42,
      agentState: 'listening',
      isDarkMode: false,
    });
  });

  it('still renders the turns and the composer around it', () => {
    const renderer = render();

    expect(renderer.root.findAllByType('TheTurns')).toHaveLength(1);
    expect(renderer.root.findAllByType('TheComposer')).toHaveLength(1);
  });

  it('leaves the project crumb off a chat that belongs to none', () => {
    // Bloom 3.3.0 made `project` optional for exactly this. Passing '' would
    // draw an empty crumb and a folder glyph for a project nobody named.
    const container = render().root.findByType('AiChatContainer');

    expect(container.props.project).toBeUndefined();
  });

  it('keeps the composer above the keyboard on a device', () => {
    // Bloom's ai-chat family imports no keyboard controller at all — verified
    // against 3.3.0 — so the host composes it back. Without this the thread
    // scrolls under the keyboard and the composer sits behind it on native.
    expect(render().root.findAllByType('KeyboardAvoidingView')).toHaveLength(1);
  });
});
