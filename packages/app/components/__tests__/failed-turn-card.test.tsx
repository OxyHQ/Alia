import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The error a failed turn is drawn with.
 *
 * Three things are pinned: which line it says (interrupted vs. couldn't
 * answer), that a retry is offered exactly when the server allowed one, and
 * that pressing it calls back — rather than merely that a card renders.
 */

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return { View: host('View'), Pressable: host('Pressable') };
});

vi.mock('lucide-react-native', async () => {
  const ReactModule = await import('react');
  return { AlertTriangle: (props: Record<string, unknown>) => ReactModule.createElement('AlertTriangle', props) };
});

vi.mock('@/components/ui/text', async () => {
  const ReactModule = await import('react');
  return {
    Text: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Text', props, children),
  };
});

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { FailedTurnCard } from '@/components/chat/failed-turn-card';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;

function render(element: React.ReactElement) {
  let next: ReactTestRenderer | undefined;
  act(() => {
    next = create(element);
  });
  if (next === undefined) throw new Error('the card did not render');
  renderer = next;
  return next;
}

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
});

/** Every string in the tree, which is what a reader sees. */
function text(r: ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') { out.push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object' && 'children' in node) walk((node as { children: unknown }).children);
  };
  walk(r.toJSON());
  return out.join(' ');
}

/** Host nodes by name — `name` is typed as `string` so `type` stays wide. */
const nodes = (r: ReactTestRenderer, name: string) => r.root.findAll((node) => node.type === name);

const retryButton = (r: ReactTestRenderer) =>
  nodes(r, 'Pressable').filter((node) => node.props.accessibilityLabel === 'chat.retry');

describe('FailedTurnCard', () => {
  it('says Alia could not answer, and offers to try again', () => {
    const onRetry = vi.fn();
    const r = render(<FailedTurnCard partial={false} retryable onRetry={onRetry} />);

    expect(text(r)).toContain('chat.turnFailed');
    expect(text(r)).toContain('chat.turnFailedRetryHint');
    expect(retryButton(r)).toHaveLength(1);

    act(() => retryButton(r)[0].props.onPress());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('says the answer was interrupted when real output came first', () => {
    const r = render(<FailedTurnCard partial retryable onRetry={() => {}} />);

    expect(text(r)).toContain('chat.turnInterrupted');
    expect(text(r)).not.toContain('chat.turnFailed ');
  });

  it('offers no retry when the server said not to, and drops the hint with it', () => {
    const r = render(<FailedTurnCard partial={false} retryable={false} onRetry={() => {}} />);

    expect(retryButton(r)).toHaveLength(0);
    expect(text(r)).not.toContain('chat.turnFailedRetryHint');
  });

  it('is announced as an alert and repeats the server’s own words as detail', () => {
    const r = render(<FailedTurnCard partial={false} retryable detail="Server error (503)" onRetry={() => {}} />);

    const alert = nodes(r, 'View').filter((node) => node.props.accessibilityRole === 'alert');
    expect(alert).toHaveLength(1);
    expect(text(r)).toContain('Server error (503)');
  });
});
