import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A like or a dislike is addressed to the conversation that HOLDS the message, pressing the same
 * one again retracts it, and a press that cannot land says so instead of thanking nobody.
 */

const wire = vi.hoisted(() => ({
  sent: [] as [string, unknown][],
  fail: false,
  release: null as null | (() => void),
  hold: false,
}));
vi.mock('../../src/runtime/api', () => ({
  useAliaApi: () => ({
    patch: async (path: string, body: unknown) => {
      wire.sent.push([path, body]);
      if (wire.hold) await new Promise<void>((resolve) => (wire.release = resolve));
      if (wire.fail) throw new Error('refused');
      return { status: 200, data: {} };
    },
  }),
}));
const toasts = vi.hoisted(() => ({ success: [] as string[], error: [] as string[] }));
vi.mock('@oxy.so/bloom/toast', () => ({
  toast: {
    success: (message: string) => toasts.success.push(message),
    error: (message: string) => toasts.error.push(message),
  },
}));
vi.mock('../../src/lib/labels', () => ({ useLabels: () => ({ t: (key: string) => key }) }));

import { useMessageVote } from '../../src/hooks/useMessageVote';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | undefined;
function mount() {
  let vote!: ReturnType<typeof useMessageVote>;
  function Probe() {
    vote = useMessageVote();
    return null;
  }
  act(() => {
    renderer = create(<Probe />);
  });
  return (...args: Parameters<typeof vote>) =>
    act(async () => {
      vote(...args);
      await Promise.resolve();
    });
}

beforeEach(() => {
  wire.sent = [];
  wire.fail = false;
  wire.hold = false;
  wire.release = null;
  toasts.success = [];
  toasts.error = [];
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('voting on a reply', () => {
  it('goes to the conversation that holds it, and says thanks once the server took it', async () => {
    const vote = mount();
    await vote('a2', 'up', 'c-old');
    expect(wire.sent).toEqual([['/v1/conversations/c-old/messages/a2/vote', { vote: 'up' }]]);
    expect(toasts.success).toEqual(['chat.thanksFeedback']);
  });

  it('retracts a vote when the same one is pressed again', async () => {
    const vote = mount();
    await vote('a2', 'up', 'c1');
    await vote('a2', 'up', 'c1');
    expect(wire.sent.map(([, body]) => body)).toEqual([{ vote: 'up' }, { vote: null }]);
  });

  it('changes a vote for the other one', async () => {
    const vote = mount();
    await vote('a2', 'up', 'c1');
    await vote('a2', 'down', 'c1');
    expect(wire.sent.map(([, body]) => body)).toEqual([{ vote: 'up' }, { vote: 'down' }]);
  });

  it('says so when no conversation holds the message yet, and sends nothing', async () => {
    const vote = mount();
    await vote('a2', 'up', undefined);
    expect(wire.sent).toEqual([]);
    expect(toasts.error).toEqual(['chat.feedbackFailed']);
    expect(toasts.success).toEqual([]);
  });

  it('reports a refusal, and the next press casts the vote again rather than retracting it', async () => {
    const vote = mount();
    wire.fail = true;
    await vote('a2', 'up', 'c1');
    await act(async () => Promise.resolve());
    expect(toasts.error).toEqual(['chat.feedbackFailed']);

    wire.fail = false;
    await vote('a2', 'up', 'c1');
    expect(wire.sent.map(([, body]) => body)).toEqual([{ vote: 'up' }, { vote: 'up' }]);
  });

  it('takes no second press on a message while its first is still on the way', async () => {
    const vote = mount();
    wire.hold = true;
    await vote('a2', 'up', 'c1');
    await vote('a2', 'down', 'c1');
    expect(wire.sent).toHaveLength(1);
    await act(async () => wire.release?.());
  });
});
