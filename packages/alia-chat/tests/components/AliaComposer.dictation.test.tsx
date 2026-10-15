import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The composer's microphone is dictation through Alia: pressing it records,
 * releasing it transcribes, and the text lands in the draft the person has at
 * that moment. A failure is said with a retry that re-sends the same clip.
 * Bloom's panel is stubbed to capture its props; the recorder and `fetch` are
 * fakes.
 */

const panel = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
const toastError = vi.hoisted(() => vi.fn());
const rec = vi.hoisted(() => ({ started: 0 }));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  return {
    Platform: { OS: 'web' },
    View: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('View', props, children),
  };
});
vi.mock('@oxy.so/bloom/composer-panel', () => ({
  ComposerPill: (props: Record<string, unknown>) => {
    panel.props = props;
    return null;
  },
}));
vi.mock('@oxy.so/bloom/composer-loader', () => ({
  ComposerLoader: ({ children }: React.PropsWithChildren) => children,
}));
vi.mock('@oxy.so/bloom/typography', async () => {
  const ReactModule = await import('react');
  return {
    Text: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Text', props, children),
  };
});
vi.mock('@oxy.so/bloom/item', () => ({ Item: () => null }));
vi.mock('@oxy.so/bloom/questionnaire', () => ({ Questionnaire: () => null }));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: toastError } }));
vi.mock('../../src/lib/keyboard', () => ({
  KeyboardAvoidingView: ({ children }: React.PropsWithChildren) => children,
}));
vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({ oxyServices: { session: { accessToken: 'tok' } } }),
}));
vi.mock('../../src/lib/dictation-recorder', async () => {
  const types = await import('../../src/lib/dictation-recorder-types');
  const recorder = {
    async start() {
      rec.started += 1;
    },
    async stop() {
      return {
        file: new Blob([new Uint8Array([1])], { type: 'audio/webm' }),
        mediaType: 'audio/webm',
        durationMs: 2_000,
      };
    },
    cancel() {},
  };
  return { ...types, useDictationRecorder: () => recorder };
});

import { AliaComposer } from '../../src/components/AliaComposer';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | undefined;
let draft: string;

function Host() {
  const [value, setValue] = React.useState('Hola');
  draft = value;
  return (
    <AliaComposer
      value={value}
      onValueChange={setValue}
      onSubmit={() => undefined}
      speechLanguage="es-ES"
      apiUrl="https://api.alia.test"
    />
  );
}

const press = (next: 'recording' | 'idle') =>
  (panel.props?.onVoiceStateChange as (state: string) => void)(next);

beforeEach(() => {
  panel.props = null;
  toastError.mockClear();
  rec.started = 0;
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe('AliaComposer dictation', () => {
  it('records, then appends the transcription to the draft', async () => {
    const fetchMock = vi.fn(
      async (_url: string) => new Response(JSON.stringify({ text: 'qué tal' })),
    );
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      renderer = create(<Host />);
    });
    expect(panel.props?.voiceState).toBe('idle');
    await act(async () => press('recording'));
    expect(rec.started).toBe(1);
    expect(panel.props?.voiceState).toBe('recording');
    await act(async () => press('idle'));
    expect(draft).toBe('Hola qué tal');
    expect(panel.props?.voiceState).toBe('idle');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.alia.test/v1/audio/transcriptions');
  });

  it('says a failed transcription with a retry, and leaves the draft as it was', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { code: 'TRANSCRIPTION_FAILED', message: 'x', retryable: true },
          }),
          { status: 502 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: 'otra vez' })));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      renderer = create(<Host />);
    });
    await act(async () => press('recording'));
    await act(async () => press('idle'));
    expect(draft).toBe('Hola');
    expect(toastError).toHaveBeenCalledOnce();
    const [message, options] = toastError.mock.calls[0] as [
      string,
      { action: { onClick: () => void } },
    ];
    expect(message).toBe('Dictation failed — try again');
    await act(async () => {
      options.action.onClick();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(draft).toBe('Hola otra vez'));
    expect(rec.started).toBe(1);
  });
});
