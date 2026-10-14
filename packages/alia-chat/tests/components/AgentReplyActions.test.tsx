import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return { View: host('View'), Pressable: host('Pressable') };
});
vi.mock('@oxy.so/bloom/icons', () => ({
  RiFileCopyLine: 'copy-icon',
  RiStopFill: 'stop-icon',
  RiVolumeUpLine: 'volume-icon',
  RiThumbUpLine: 'up-icon',
  RiThumbDownLine: 'down-icon',
}));
vi.mock('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({
    colors: { backgroundTertiary: '#ddd', primary: '#70f', textTertiary: '#999' },
  }),
}));

import { AgentReplyActions } from '../../src/components/AgentReplyActions';

const render = (element: React.ReactElement) => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
};
const tile = (r: TestRenderer.ReactTestRenderer, label: string) =>
  r.root.findByProps({ accessibilityLabel: label });

describe('AgentReplyActions', () => {
  it('draws helpful, unhelpful and copy, and keeps the vote the person gave', () => {
    const onLike = vi.fn();
    const onDislike = vi.fn();
    const onCopy = vi.fn();
    const r = render(<AgentReplyActions onLike={onLike} onDislike={onDislike} onCopy={onCopy} />);

    act(() => tile(r, 'Helpful response').props.onPress());
    expect(onLike).toHaveBeenCalledOnce();
    expect(tile(r, 'Helpful response').props['aria-pressed']).toBe(true);
    expect(tile(r, 'Unhelpful response').props['aria-pressed']).toBe(false);

    act(() => tile(r, 'Unhelpful response').props.onPress());
    expect(onDislike).toHaveBeenCalledOnce();
    expect(tile(r, 'Helpful response').props['aria-pressed']).toBe(false);

    act(() => tile(r, 'Copy').props.onPress());
    expect(onCopy).toHaveBeenCalledOnce();
  });

  it('always draws the three tiles and adds read aloud only where the host reads', () => {
    const onReadAloud = vi.fn();
    const r = render(<AgentReplyActions onCopy={vi.fn()} onReadAloud={onReadAloud} />);
    expect(r.root.findAll((node) => (node.type as unknown) === 'Pressable')).toHaveLength(4);

    act(() => tile(r, 'Read aloud').props.onPress());
    expect(onReadAloud).toHaveBeenCalledOnce();

    const plain = render(<AgentReplyActions onCopy={vi.fn()} />);
    expect(plain.root.findAll((node) => (node.type as unknown) === 'Pressable')).toHaveLength(3);
  });

  it('turns read aloud into stop while the reply is being read', () => {
    const r = render(<AgentReplyActions onCopy={vi.fn()} onReadAloud={vi.fn()} reading />);
    expect(tile(r, 'Stop reading').props['aria-pressed']).toBe(true);
  });
});
