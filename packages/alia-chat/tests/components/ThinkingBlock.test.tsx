import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));

vi.mock('@oxy.so/bloom/agent-thinking', () => ({
  AgentThinking: (props: Record<string, unknown>) => {
    seen.props.push(props);
    return null;
  },
}));
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('../../src/components/Markdown', () => ({ AliaMarkdown: () => null }));

import { ThinkingBlock } from '../../src/components/ThinkingBlock';

const last = () => seen.props.at(-1) as Record<string, unknown>;

function mount(streaming: boolean): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  act(() => {
    renderer = TestRenderer.create(<ThinkingBlock text="why" streaming={streaming} />);
  });
  if (renderer === null) throw new Error('The block did not render.');
  return renderer;
}

describe('ThinkingBlock', () => {
  beforeEach(() => {
    seen.props = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("leaves the live row to Bloom's own label while it streams", () => {
    mount(true);
    expect(last()).toMatchObject({ thinking: true, variant: 'stars', label: undefined });
  });

  it('reads "Reasoning" when the block arrives already finished (history)', () => {
    mount(false);
    expect(last()).toMatchObject({ thinking: false, label: 'Reasoning' });
  });

  it('reads how long the stream ran once it stops', () => {
    const renderer = mount(true);
    act(() => {
      vi.advanceTimersByTime(7_000);
    });
    act(() => {
      renderer.update(<ThinkingBlock text="why" streaming={false} />);
    });
    expect(last()).toMatchObject({ thinking: false, label: 'Thought for 7 seconds' });
  });
});
