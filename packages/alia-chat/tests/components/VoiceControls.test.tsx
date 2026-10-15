import type React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

/**
 * What the call bar SAYS. Bloom's pieces are hosts here: the words are this
 * component's, and the words are what the owner's report was about — the bar
 * read "Listening…" while nothing was listening.
 */
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  return {
    View: ({ children }: React.PropsWithChildren) =>
      ReactModule.createElement('View', null, children),
  };
});
vi.mock('@oxy.so/bloom/typography', async () => {
  const ReactModule = await import('react');
  return {
    Text: ({ children }: React.PropsWithChildren) =>
      ReactModule.createElement('Text', null, children),
  };
});
vi.mock('@oxy.so/bloom/loading', async () => {
  const ReactModule = await import('react');
  return { Loading: () => ReactModule.createElement('Loading') };
});
vi.mock('@oxy.so/bloom/voice', async () => {
  const ReactModule = await import('react');
  return { VoiceControls: () => ReactModule.createElement('BloomVoiceControls') };
});

import { VoiceControls, type VoiceControlsProps } from '../../src/components/voice/VoiceControls';

function statusOf(props: Partial<VoiceControlsProps>): string | null {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(
      <VoiceControls
        roomState="connected"
        agentState="listening"
        isMuted={false}
        onToggleMute={vi.fn()}
        onEnd={vi.fn()}
        {...props}
      />,
    );
  });
  const text = renderer?.root.findAll((node) => (node.type as unknown) === 'Text')[0];
  return text === undefined ? null : String(text.props.children);
}

describe('the call bar', () => {
  it('says connecting, with no controls, until the recognizer has started', () => {
    expect(statusOf({ roomState: 'connecting', agentState: 'idle' })).toBe('Connecting...');
  });

  it('says listening once it is', () => {
    expect(statusOf({})).toBe('Listening...');
  });

  it('says what is wrong instead of listening while the microphone is silent', () => {
    expect(statusOf({ notice: "I can't hear you" })).toBe("I can't hear you");
    expect(statusOf({ notice: "I can't hear you", isMuted: true })).toBe('Muted');
    expect(statusOf({ notice: "I can't hear you", agentState: 'speaking' })).toBe('Speaking...');
  });
});
