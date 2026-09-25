import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The composer as a place files arrive: dropped on it, sent on their own, and
 * failing to read.
 *
 * `useComposerDropTarget` and `ComposerDropOverlay` were written and imported
 * nowhere, so on web a file dropped on the composer did what the browser does
 * by default — navigated the tab to it. `drop-zone.test.tsx` pins the hook;
 * this pins that the composer MOUNTS it, on its own element, into the same
 * intake a paste uses. Bloom's panel is stubbed to capture its props: what is
 * asserted is what Alia hands it.
 */

const panel = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
const toastError = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  return {
    Platform: { OS: 'web' },
    View: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('View', props, children),
  };
});
vi.mock('@oxy.so/bloom/composer-panel', () => ({
  ComposerPanel: (props: Record<string, unknown>) => {
    panel.props = props;
    return null;
  },
}));
vi.mock('@oxy.so/bloom/typography', async () => {
  const ReactModule = await import('react');
  return {
    Text: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Text', props, children),
  };
});
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: toastError } }));
vi.mock('@/lib/keyboard', () => ({
  KeyboardAvoidingView: ({ children }: React.PropsWithChildren) => children,
}));
vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.name ? `${key}:${String(options.name)}` : key,
  }),
}));
vi.mock('@/lib/hooks/use-speech-to-text', () => ({
  useSpeechToText: () => ({
    isRecording: false,
    isTranscribing: false,
    error: null,
    startRecording: vi.fn(),
    stopAndTranscribe: vi.fn(async () => null),
  }),
}));

import { Composer } from '../composer';
import { composerTiles } from '../attachment-tiles';
import type { IntakeItem } from '../use-attachment-intake';
import type { Attachment } from '../types';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Listener = (event: unknown) => void;

/** The composer's host element, as `document.getElementById` hands it back. */
let listeners: Map<string, Set<Listener>>;
let lookedUp: string[];
let renderer: ReactTestRenderer | null = null;

/** Whether the next read fails or lands; a failed one exercises the retry. */
let readSucceeds = false;
class ScriptedReader {
  onprogress: unknown = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  result: string | null = null;
  readAsDataURL() {
    if (readSucceeds) {
      this.result = 'data:image/png;base64,AA';
      this.onload?.();
    } else this.onerror?.();
  }
  abort() {}
}

beforeEach(() => {
  listeners = new Map();
  lookedUp = [];
  panel.props = null;
  toastError.mockClear();
  const element = {
    addEventListener: (type: string, listener: Listener) => {
      const set = listeners.get(type) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: Listener) => listeners.get(type)?.delete(listener),
  };
  vi.stubGlobal('document', {
    getElementById: (id: string) => {
      lookedUp.push(id);
      return element;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal('FileReader', ScriptedReader);
  readSucceeds = false;
  URL.createObjectURL = vi.fn(() => 'blob:http://app/dropped');
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

function fire(type: string, files: File[] = []) {
  const event = {
    preventDefault: vi.fn(),
    dataTransfer: { types: ['Files'], files, dropEffect: '' },
  };
  act(() => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
  });
  return event;
}

function mount(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
  act(() => {
    renderer = create(
      <Composer value="" onValueChange={() => {}} onSubmit={() => {}} {...props} />,
    );
  });
}

const overlay = () =>
  renderer!.root.findAll((node) => node.type === ('View' as never) && node.props.accessibilityRole === 'alert');

describe('dropping files on the composer', () => {
  it('listens on its own element, the one the paste target uses', () => {
    mount();
    const host = renderer!.root.findAll((node) => typeof node.props.id === 'string')[0];

    expect(lookedUp).toContain(host.props.id);
    expect(listeners.get('drop')?.size).toBe(1);
  });

  it('draws the drop hint while a file is over it, and takes the file', () => {
    const added: Attachment[] = [];
    mount({ attachments: [], onAddAttachment: (a) => added.push(a) });

    fire('dragenter');
    expect(overlay()).toHaveLength(1);

    const pdf = new File(['%PDF'], 'notes.pdf', { type: 'application/pdf' });
    const drop = fire('drop', [pdf]);

    expect(drop.preventDefault).toHaveBeenCalled();
    expect(overlay()).toHaveLength(0);
    expect(added).toMatchObject([{ name: 'notes.pdf', type: 'document', uri: 'blob:http://app/dropped' }]);
  });

  it('takes nothing while a turn is running, and says so', () => {
    const added: Attachment[] = [];
    mount({ busy: true, attachments: [], onAddAttachment: (a) => added.push(a) });

    fire('dragenter');
    expect(overlay()[0]?.findByType('Text' as never).props.children).toBe('composer.dropUnavailable');
    fire('drop', [new File(['x'], 'a.pdf', { type: 'application/pdf' })]);

    expect(added).toEqual([]);
  });

  it('takes no file and draws no hint where the surface sends only text', () => {
    // No `onAddAttachment`: create-agent, create-skill, an agent's hire box.
    mount();

    fire('dragenter');
    expect(overlay()).toHaveLength(0);
    const drop = fire('drop', [new File(['x'], 'a.pdf', { type: 'application/pdf' })]);

    // The page is still saved from the browser opening the file in its place.
    expect(drop.preventDefault).toHaveBeenCalled();
    expect(panel.props?.attachments).toEqual([]);
  });

  it('stops listening when it goes away', () => {
    mount();
    act(() => renderer?.unmount());
    renderer = null;

    expect(listeners.get('drop')?.size ?? 0).toBe(0);
  });
});

describe('a message that is only a file', () => {
  it('can be sent with no text', () => {
    mount({ attachments: [{ id: 'a', uri: 'data:image/png;base64,AA', type: 'image', name: 'a.png', size: 2, mimeType: 'image/png' }] });

    expect(panel.props?.disabled).toBe(false);
  });

  it('cannot be sent with neither', () => {
    mount({ attachments: [] });

    expect(panel.props?.disabled).toBe(true);
  });
});

describe('a file that could not be read', () => {
  it('stays as an error tile, not a toast, and is read again on retry', () => {
    const added: Attachment[] = [];
    mount({ attachments: [], onAddAttachment: (a) => added.push(a) });

    fire('drop', [new File(['png'], 'cat.png', { type: 'image/png' })]);

    expect(added).toEqual([]);
    expect(toastError).not.toHaveBeenCalled();
    const tiles = panel.props?.attachments as Array<Record<string, unknown>>;
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toMatchObject({ name: 'cat.png', error: 'composer.readFailed:cat.png' });
    // Bloom's own tile type: the intake's flag stays on this side.
    expect('retryable' in tiles[0]!).toBe(false);
    // A failed read is not work in progress: it does not hold send back.
    expect(panel.props?.disabled).toBe(true);

    readSucceeds = true;
    act(() => (panel.props?.onAttachmentRetry as (id: string) => void)(tiles[0]!.id as string));

    // The same file, read again, and landed.
    expect(added).toMatchObject([{ name: 'cat.png', uri: 'data:image/png;base64,AA' }]);
  });

  it('clears the error and shows progress again while the retry reads', () => {
    let pendingLoad: (() => void) | null = null;
    class SlowReader extends ScriptedReader {
      readAsDataURL() {
        if (!readSucceeds) return this.onerror?.();
        pendingLoad = () => {
          this.result = 'data:image/png;base64,AA';
          this.onload?.();
        };
      }
    }
    vi.stubGlobal('FileReader', SlowReader);
    mount({ attachments: [], onAddAttachment: () => {} });
    fire('drop', [new File(['png'], 'cat.png', { type: 'image/png' })]);
    const failed = (panel.props?.attachments as Array<Record<string, unknown>>)[0]!;

    readSucceeds = true;
    act(() => (panel.props?.onAttachmentRetry as (id: string) => void)(failed.id as string));

    const retrying = (panel.props?.attachments as Array<Record<string, unknown>>)[0]!;
    expect(retrying.error).toBeUndefined();
    expect(retrying.progress).toBe(0);
    expect(pendingLoad).not.toBeNull();
  });

  it('says a refusal in a toast, and draws no tile it would offer to retry', () => {
    mount({ attachments: [], onAddAttachment: () => {} });

    fire('drop', [new File([], 'empty.png', { type: 'image/png' })]);

    expect(toastError).toHaveBeenCalledWith('composer.fileEmpty:empty.png');
    expect(panel.props?.attachments).toEqual([]);
  });

  it('names the retry button in the user’s language', () => {
    mount({ attachments: [], onAddAttachment: () => {} });

    expect((panel.props?.labels as Record<string, string>).retry).toBe('composer.retryShort');
  });

  it('becomes an error tile the user can retry, and a refusal one they cannot', () => {
    const t = (key: string, options?: Record<string, unknown>) =>
      options?.name ? `${key}:${String(options.name)}` : key;
    const items: IntakeItem[] = [
      { id: 'r', name: 'cat.png', size: 3, mimeType: 'image/png', kind: 'image', status: 'reading', fraction: 0.5 },
      { id: 'f', name: 'dog.png', size: 3, mimeType: 'image/png', kind: 'image', status: 'failed', fraction: null },
      { id: 'x', name: 'huge.png', size: 9e9, mimeType: 'image/png', kind: 'document', status: 'refused', fraction: null, refusal: 'too-large' },
    ];

    expect(composerTiles([], items, t)).toEqual([
      { id: 'r', name: 'cat.png', kind: 'image', progress: 50 },
      { id: 'f', name: 'dog.png', kind: 'image', error: 'composer.readFailed:dog.png', retryable: true },
      { id: 'x', name: 'huge.png', kind: 'document', error: 'composer.fileTooLarge:huge.png', retryable: false },
    ]);
  });
});
