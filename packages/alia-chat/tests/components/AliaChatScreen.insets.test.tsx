import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  insets: { top: 24, bottom: 48, left: 0, right: 0 },
}));

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  ScrollView: 'ScrollView',
  KeyboardAvoidingView: 'RNKeyboardAvoidingView',
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => mocks.insets,
}));

vi.mock('../../src/components/AliaChatContent', () => ({
  AliaChatContent: () => React.createElement('AliaChatContent'),
}));

vi.mock('../../src/components/IdentityMark', () => ({
  IdentityMark: () => null,
}));

import { AliaChatScreen } from '../../src/components/AliaChatScreen';
import { KeyboardAvoidingView } from '../../src/lib/keyboard';

type Style = Record<string, unknown>;

function flatStyle(node: ReactTestInstance): Style {
  const style = node.props.style as Style | Style[] | undefined;
  return Array.isArray(style) ? Object.assign({}, ...style) : { ...style };
}

let renderer: TestRenderer.ReactTestRenderer | null = null;

function render(element: React.ReactElement): TestRenderer.ReactTestRenderer {
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer!;
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

// On edge-to-edge Android the window runs under the gesture bar, and the screen
// padded only the top: the composer sat under the gesture bar (OxyHQ/Mention#1140).
describe('AliaChatScreen safe area and keyboard', () => {
  it('pads the screen by the top and the bottom safe-area insets', () => {
    const root = render(<AliaChatScreen />).root.findByType('View' as never);
    expect(flatStyle(root)).toMatchObject({ paddingTop: 24, paddingBottom: 48 });
  });

  it('follows the insets the device reports', () => {
    mocks.insets = { top: 0, bottom: 0, left: 0, right: 0 };
    try {
      const root = render(<AliaChatScreen />).root.findByType('View' as never);
      expect(flatStyle(root)).toMatchObject({ paddingTop: 0, paddingBottom: 0 });
    } finally {
      mocks.insets = { top: 24, bottom: 48, left: 0, right: 0 };
    }
  });

  it('lifts the composer over the keyboard from inside the bottom inset, measured in the window', () => {
    const tree = render(<AliaChatScreen />).root;
    const screen = tree.findByType('View' as never);
    const avoiding = tree.findByType(KeyboardAvoidingView);

    // The avoiding view is the screen's only child, so its frame ends where the
    // bottom inset begins; its padding is then the keyboard minus the inset
    // rather than the keyboard plus it.
    expect(screen.children).toEqual([avoiding]);
    expect(avoiding.props.behavior).toBe('padding');
    expect(avoiding.props.automaticOffset).toBe(true);
    expect(flatStyle(avoiding)).toEqual({ flex: 1 });

    // The chat, composer included, is what gets lifted.
    expect(avoiding.findAllByType('AliaChatContent' as never)).toHaveLength(1);
  });
});

describe('web KeyboardAvoidingView shim', () => {
  it("drops keyboard-controller's automaticOffset before it reaches React Native", () => {
    const tree = render(
      <KeyboardAvoidingView behavior="padding" automaticOffset style={{ flex: 1 }} />,
    ).root;
    const host = tree.findByType('RNKeyboardAvoidingView' as never);
    expect(host.props).not.toHaveProperty('automaticOffset');
    expect(host.props.behavior).toBe('padding');
    expect(host.props.style).toEqual({ flex: 1 });
  });
});
