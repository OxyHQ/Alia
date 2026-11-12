import { describe, expect, it, vi } from 'vitest';
import {
  applyMessageReaction,
  MessageReactionController,
  readMessageReactionUpdate,
  type MessageReactionMutation,
  type MessageReactionUpdate,
} from '../../src/runtime/message-reactions';

const update = (
  revision: number,
  reactions: string[],
  mutationId?: string,
): MessageReactionUpdate => ({
  conversationId: 'c1',
  messageId: 'm1',
  reactions,
  revision,
  mutationId,
});
const tick = async () => {
  for (let n = 0; n < 8; n += 1) await Promise.resolve();
};
function setup() {
  const pending: {
    mutation: MessageReactionMutation;
    resolve: (value: MessageReactionUpdate) => void;
    reject: (reason: unknown) => void;
  }[] = [];
  const confirmed = vi.fn();
  const failed = vi.fn();
  const controller = new MessageReactionController({
    send: (mutation) =>
      new Promise((resolve, reject) => pending.push({ mutation, resolve, reject })),
    changed: vi.fn(),
    confirmed,
    failed,
  });
  const toggle = (emoji = '❤️') => controller.toggle('c1', 'm1', emoji, []);
  const visible = () => controller.reactionsOf('c1', 'm1', []);
  const accept = async (index: number, revision: number, reactions: string[]) => {
    const request = pending[index];
    if (!request) throw new Error('Missing request');
    request.resolve(update(revision, reactions, request.mutation.mutationId));
    await tick();
  };
  return { controller, pending, confirmed, failed, toggle, visible, accept };
}

describe('ordered reaction intent', () => {
  it('shows a reaction immediately and sends explicit desired state with a mutation ID', async () => {
    const h = setup();
    h.toggle();
    expect(h.visible()).toEqual(['❤️']);
    expect(h.pending[0]?.mutation).toMatchObject({
      conversationId: 'c1',
      messageId: 'm1',
      emoji: '❤️',
      active: true,
      mutationId: expect.any(String),
    });
    await h.accept(0, 1, ['❤️']);
    expect(h.visible()).toEqual(['❤️']);
    expect(h.failed).not.toHaveBeenCalled();
  });
  it('preserves a rapid retraction while the first write is pending, without flashing the old acknowledgement', async () => {
    const h = setup();
    h.toggle();
    h.toggle();
    expect(h.visible()).toEqual([]);
    expect(h.pending).toHaveLength(1);
    await h.accept(0, 1, ['❤️']);
    expect(h.visible()).toEqual([]);
    expect(h.pending[1]?.mutation.active).toBe(false);
    expect(h.pending[1]?.mutation.mutationId).not.toBe(h.pending[0]?.mutation.mutationId);
    await h.accept(1, 2, []);
    expect(h.visible()).toEqual([]);
  });
  it('coalesces each emoji to its latest intent and keeps different emoji writes ordered', async () => {
    const h = setup();
    h.toggle();
    h.toggle('🎉');
    h.toggle();
    h.toggle();
    expect(h.visible()).toEqual(['❤️', '🎉']);
    await h.accept(0, 1, ['❤️']);
    expect(h.pending[1]?.mutation).toMatchObject({ emoji: '🎉', active: true });
    await h.accept(1, 2, ['❤️', '🎉']);
    expect(h.pending[2]?.mutation).toMatchObject({ emoji: '❤️', active: true });
    await h.accept(2, 2, ['❤️', '🎉']);
    expect(h.visible()).toEqual(['❤️', '🎉']);
  });
  it('does not retry ambiguous failures even after a versioned acknowledgement', async () => {
    const h = setup();
    h.toggle();
    await h.accept(0, 1, ['❤️']);
    h.toggle();
    h.pending[1]?.reject(new Error('connection lost'));
    await tick();
    expect(h.pending).toHaveLength(2);
    expect(h.visible()).toEqual(['❤️']);
    expect(h.failed).toHaveBeenCalledOnce();
  });
  it('uses a socket acknowledgement when the HTTP response is lost, without sending twice', async () => {
    const h = setup();
    h.toggle();
    h.controller.receive(update(1, ['❤️'], h.pending[0]?.mutation.mutationId));
    h.pending[0]?.reject(new Error('response lost'));
    await tick();
    expect(h.pending).toHaveLength(1);
    expect(h.visible()).toEqual(['❤️']);
    expect(h.failed).not.toHaveBeenCalled();
  });
  it('does not overwrite newer socket state with an older HTTP result', async () => {
    const h = setup();
    h.toggle();
    h.controller.receive(update(3, ['🎉']));
    await h.accept(0, 1, ['❤️']);
    expect(h.visible()).toEqual(['🎉']);
    h.controller.receive(update(2, ['❤️']));
    expect(h.visible()).toEqual(['🎉']);
  });
  it('lets newer stored snapshots replace previously acknowledged local state', async () => {
    const h = setup();
    h.toggle();
    await h.accept(0, 1, ['❤️']);
    expect(h.controller.reactionsOf('c1', 'm1', ['🔥'], 4)).toEqual(['🔥']);
    h.controller.toggle('c1', 'm1', '🔥', ['🔥'], 4);
    expect(h.pending[1]?.mutation.active).toBe(false);
  });
  it('rolls back a refused final intent and reports only the saving failure', async () => {
    const h = setup();
    h.toggle();
    h.pending[0]?.reject({ status: 403 });
    await tick();
    expect(h.pending).toHaveLength(1);
    expect(h.visible()).toEqual([]);
    expect(h.failed).toHaveBeenCalledOnce();
  });
  it('continues a newer retraction after an older write fails, without reporting the superseded intent', async () => {
    const h = setup();
    h.toggle();
    h.toggle();
    h.pending[0]?.reject({ status: 503 });
    await tick();
    expect(h.pending[1]?.mutation.active).toBe(false);
    expect(h.failed).not.toHaveBeenCalled();
    await h.accept(1, 2, []);
    expect(h.visible()).toEqual([]);
  });
  it('accepts server limits as authoritative rather than keeping an unaccepted emoji', async () => {
    const h = setup();
    h.toggle();
    await h.accept(0, 0, []);
    expect(h.visible()).toEqual([]);
  });
  it('scopes identical message IDs to their conversation', () => {
    const h = setup();
    h.controller.receive(update(1, ['❤️']));
    expect(h.controller.reactionsOf('other', 'm1', [])).toEqual([]);
  });
  it('drops late effects and pending writes after account scope disposal', async () => {
    const h = setup();
    h.toggle();
    h.toggle();
    h.controller.dispose();
    await h.accept(0, 1, ['❤️']);
    expect(h.pending).toHaveLength(1);
    expect(h.confirmed).not.toHaveBeenCalled();
  });
});

describe('authoritative reaction messages', () => {
  it('validates revisions and the existing target identity', () => {
    expect(readMessageReactionUpdate(update(1, ['❤️']))).toEqual(update(1, ['❤️']));
    for (const bad of [
      null,
      {},
      { ...update(1, []), revision: -1 },
      { ...update(1, []), revision: 1.2 },
      { ...update(1, []), reactions: [7] },
      { ...update(1, []), messageId: '' },
    ])
      expect(readMessageReactionUpdate(bad)).toBeNull();
  });
  it('changes only the existing target and rejects stale revisions without creating messages', () => {
    const messages = [
      { id: 'm1', reactions: ['🔥'], reactionRevision: 3 },
      { id: 'm2', reactions: [] },
    ];
    expect(applyMessageReaction(messages, update(2, ['❤️']))).toEqual(messages);
    expect(applyMessageReaction(messages, update(4, []))[0]).toMatchObject({
      reactions: [],
      reactionRevision: 4,
    });
    expect(applyMessageReaction([] as typeof messages, update(1, ['❤️']))).toEqual([]);
  });
});
