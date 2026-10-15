import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return {
    View: host('View'),
    Platform: {
      OS: 'web',
      select: (o: Record<string, unknown>) => o.web ?? o.default,
    },
  };
});

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 48, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/shared/platform/keyboard', async () => {
  const ReactModule = await import('react');
  return {
    KeyboardAvoidingView: ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('KeyboardAvoidingView', props, children),
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
      ReactModule.createElement('AiChatContainer', props, background, header, children, composer),
  };
});

import { ChatWorkspace, KeyboardFrame } from '@/features/chat/ui/chat-workspace';

function render(over: Record<string, unknown> = {}) {
  let renderer: any;
  act(() => {
    renderer = create(
      React.createElement(ChatWorkspace, {
        header: React.createElement('TheHeader'),
        children: React.createElement('TheContent'),
        ...over,
      } as any),
    );
  });
  return renderer;
}

describe('the chat frame around a screen that is not a conversation', () => {
  it('draws the content in Bloom’s container, with the header over it', () => {
    const renderer = render();

    expect(renderer.root.findAllByType('TheContent')).toHaveLength(1);
    expect(renderer.root.findAllByType('TheHeader')).toHaveLength(1);
  });

  it('holds a layer under the content, drawn before it', () => {
    const container = render({ background: React.createElement('TheField') }).root.findByType(
      'AiChatContainer',
    );
    const order = container.children.map((child: any) =>
      typeof child === 'string' ? child : String(child.type),
    );

    expect(order.indexOf('TheField')).toBeLessThan(order.indexOf('TheContent'));
  });

  it('keeps the content above the keyboard on a device', () => {
    // Bloom's ai-chat family imports no keyboard controller at all — verified
    // against 3.3.0 — so the host composes it back. Without this the thread
    // scrolls under the keyboard and the composer sits behind it on native.
    expect(render().root.findAllByType('KeyboardAvoidingView')).toHaveLength(1);
  });

  it('lifts it by the status bar the shell sits below', () => {
    // It measures itself against its parent, as if it began at the top of the
    // screen; the shell starts a status bar lower. Without the offset the
    // composer stopped that far behind the keyboard on the Android emulator
    // (docs/native-validation.mdx).
    const avoider = render().root.findByType('KeyboardAvoidingView');
    expect(avoider.props.keyboardVerticalOffset).toBe(48);
  });
});

describe('the keyboard frame of a conversation', () => {
  it('is the same frame, around whatever the screen puts in it', () => {
    let renderer: any;
    act(() => {
      renderer = create(React.createElement(KeyboardFrame, null, React.createElement('TheChat')));
    });
    const avoider = renderer.root.findByType('KeyboardAvoidingView');
    expect(avoider.props.keyboardVerticalOffset).toBe(48);
    expect(avoider.findAllByType('TheChat')).toHaveLength(1);
  });
});
