import React, { act, createRef, useImperativeHandle, useState } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ width: 1280, height: 844 }));
vi.mock('react-native', () => ({
  View: 'View',
  useWindowDimensions: () => state,
}));
vi.mock('react-native-reanimated', () => ({ useSharedValue: (value: number) => ({ value }) }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@oxy.so/bloom/styles', () => ({ BREAKPOINTS: { md: 768 } }));
vi.mock('@oxy.so/bloom/theme', () => ({ useTheme: () => ({ isDark: false }) }));
vi.mock('@oxy.so/bloom/agent-avatar', () => ({
  AgentAvatarProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@oxy.so/bloom/avatar-flight', () => ({
  useAvatarFlights: () => ({}),
  AvatarFlightLayer: () => null,
}));
vi.mock('../../src/lib/labels', () => ({
  AliaChatLabelsProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../../src/hooks/useShareHandler', () => ({ useShareHandler: () => undefined }));
vi.mock('../../src/runtime/thought-store', () => ({
  useThoughtStore: { getState: () => ({ close: vi.fn() }) },
}));
vi.mock('../../src/components/AliaChatHeader', () => ({ AliaChatHeader: () => null }));
vi.mock('../../src/components/AliaRecentConversations', () => ({
  AliaRecentConversations: () => null,
}));
vi.mock('../../src/components/thought/ThoughtPanel', () => ({ ThoughtPanel: () => null }));
// Network/runtime content is outside the frame contract. Keep its props observable
// so the test can exercise the real first-turn and resume transitions without inference.
vi.mock('../../src/components/AliaChatContent', () => ({
  AliaChatContent: (props: Record<string, unknown>) => React.createElement('article', props),
}));
// Geometry is covered by Bloom's real layout/browser gates. This boundary records
// presentation requests, without inventing layout measurements in a React renderer.
vi.mock('@oxy.so/bloom/bottom-sheet', () => ({
  BottomSheet: React.forwardRef(function Sheet(
    props: { children?: React.ReactNode; onDismiss?: () => void },
    ref,
  ) {
    const [open, setOpen] = useState(false);
    useImperativeHandle(ref, () => ({
      present: () => setOpen(true),
      dismiss: () => {
        setOpen(false);
        props.onDismiss?.();
      },
    }));
    return React.createElement('section', { ...props, open });
  }),
}));

import { AliaChatSheet, type AliaChatSheetRef } from '../../src/components/AliaChatSheet';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  state.width = 1280;
  state.height = 844;
});

function mount() {
  const ref = createRef<AliaChatSheetRef>();
  act(() => {
    renderer = create(<AliaChatSheet ref={ref} voice={false} />);
  });
  return ref;
}
function mounted() {
  if (!renderer) throw new Error('Sheet test is not mounted');
  return renderer;
}
const sheets = () => mounted().root.findAllByType('section');
const chats = () => mounted().root.findAllByType('article');

describe('Alia sheet bounded presentation', () => {
  it('opens the main Screen with a bounded sheet, preserves it through resize and closes', () => {
    const ref = mount();
    expect(sheets()[0].props).toMatchObject({ sizing: 'fill', scrollable: false, open: false });
    act(() => ref.current?.present());
    expect(sheets()[0].props.open).toBe(true);
    const main = chats()[0];
    state.width = 390;
    state.height = 480;
    act(() => mounted().update(<AliaChatSheet ref={ref} voice={false} />));
    expect(chats()[0]).toBe(main);
    expect(sheets()[0].props).toMatchObject({ sizing: 'fill', detached: false, open: true });
    expect(sheets()[0].props.style?.height).toBeUndefined();
    act(() => ref.current?.dismiss());
    expect(sheets().every((sheet) => !sheet.props.open)).toBe(true);
  });

  it('opens a bounded conversation above the main sheet and retains its own presentation progress', () => {
    const ref = mount();
    act(() => ref.current?.present());
    const mainProgress = chats()[0].props.presentedProgress;
    act(() => chats()[0].props.onStart({ text: 'A fixture draft' }));
    expect(sheets()).toHaveLength(3);
    expect(sheets()[1].props).toMatchObject({ sizing: 'fill', scrollable: false, open: true });
    expect(chats()[1].props.initialTurn).toEqual({ text: 'A fixture draft' });
    expect(chats()[1].props.presentedProgress).not.toBe(mainProgress);
    // The independent thought sheet keeps its own existing content sizing.
    expect(sheets()[2].props.sizing).toBeUndefined();
    act(() => ref.current?.dismiss());
    expect(sheets()).toHaveLength(2);
    expect(sheets().every((sheet) => !sheet.props.open)).toBe(true);
  });

  it('resumes an existing conversation using the same bounded frame without an initial send', () => {
    const ref = mount();
    act(() => ref.current?.resume('existing-conversation'));
    expect(
      sheets()
        .slice(0, 2)
        .every((sheet) => sheet.props.sizing === 'fill' && sheet.props.open),
    ).toBe(true);
    expect(chats()[1].props.conversationId).toBe('existing-conversation');
    expect(chats()[1].props.initialTurn).toBeUndefined();
  });
});
