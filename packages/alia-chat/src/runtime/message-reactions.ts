import type { Message } from './types';
import { createRandomUuid } from './random-uuid';

/** Saved reaction state; older HTTP responses do not carry a revision. */
export interface MessageReactionSnapshot {
  conversationId: string;
  messageId: string;
  reactions: string[];
  revision?: number;
  mutationId?: string | null;
}

/** Versioned state published by current servers over `conversation:reaction`. */
export interface MessageReactionUpdate extends MessageReactionSnapshot {
  revision: number;
}

export interface MessageReactionMutation {
  conversationId: string;
  messageId: string;
  emoji: string;
  active: boolean;
  mutationId: string;
}

export function readMessageReactionUpdate(value: unknown): MessageReactionUpdate | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.conversationId !== 'string' ||
    !v.conversationId ||
    typeof v.messageId !== 'string' ||
    !v.messageId ||
    !Array.isArray(v.reactions) ||
    !v.reactions.every((emoji) => typeof emoji === 'string' && emoji !== '') ||
    !Number.isSafeInteger(v.revision) ||
    (v.revision as number) < 0 ||
    (v.mutationId != null && (typeof v.mutationId !== 'string' || !v.mutationId))
  )
    return null;
  return v as unknown as MessageReactionUpdate;
}

/** Read current and legacy HTTP acknowledgements without treating optional metadata as failure. */
export function readMessageReactionAcknowledgement(
  value: unknown,
  conversationId: string,
  messageId: string,
  mutationId: string,
): MessageReactionSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  const update = readMessageReactionUpdate({ ...data, conversationId });
  if (
    update &&
    update.messageId === messageId &&
    (update.mutationId == null || update.mutationId === mutationId)
  )
    return update;
  if (
    Object.keys(data).length === 1 &&
    Array.isArray(data.reactions) &&
    data.reactions.every((emoji) => typeof emoji === 'string' && emoji !== '')
  ) {
    return { conversationId, messageId, reactions: data.reactions };
  }
  return null;
}

/** Update only the existing target row; a reaction never invents a chat message. */
export function applyMessageReaction<
  T extends Pick<Message, 'id' | 'reactions' | 'reactionRevision'>,
>(messages: readonly T[], update: MessageReactionSnapshot): T[] {
  return messages.map((message) =>
    message.id !== update.messageId ||
    (update.revision !== undefined && (message.reactionRevision ?? 0) > update.revision)
      ? message
      : {
          ...message,
          reactions: update.reactions,
          ...(update.revision === undefined ? {} : { reactionRevision: update.revision }),
        },
  );
}

type Intent = { active: boolean; sequence: number };
type Entry = {
  confirmed: { reactions: readonly string[]; revision: number };
  desired: Map<string, Intent>;
  running?: { mutation: MessageReactionMutation; acknowledged: boolean };
};
const keyOf = (conversationId: string, messageId: string) =>
  JSON.stringify([conversationId, messageId]);

/** Per-message ordered intent, with authoritative revisions shared by HTTP and socket arrivals. */
export class MessageReactionController {
  private entries = new Map<string, Entry>();
  private sequence = 0;
  private disposed = false;

  private readonly options: {
    send: (mutation: MessageReactionMutation) => Promise<MessageReactionSnapshot>;
    changed: () => void;
    confirmed: (update: MessageReactionSnapshot) => void;
    failed: () => void;
  };

  constructor(options: MessageReactionController['options']) {
    this.options = options;
  }

  activate(): void {
    this.disposed = false;
  }
  dispose(): void {
    this.disposed = true;
  }

  reactionsOf(
    conversationId: string,
    messageId: string,
    stored: readonly string[],
    revision = 0,
  ): readonly string[] {
    const entry = this.entries.get(keyOf(conversationId, messageId));
    if (!entry) return stored;
    let reactions = [...(revision > entry.confirmed.revision ? stored : entry.confirmed.reactions)];
    for (const [emoji, intent] of entry.desired) {
      reactions = reactions.filter((held) => held !== emoji);
      if (intent.active) reactions.push(emoji);
    }
    return reactions;
  }

  receive(update: MessageReactionSnapshot): void {
    if (this.disposed) return;
    const key = keyOf(update.conversationId, update.messageId);
    const entry: Entry = this.entries.get(key) ?? {
      confirmed: { reactions: [], revision: -1 },
      desired: new Map(),
    };
    if (entry.running && entry.running.mutation.mutationId === update.mutationId)
      entry.running.acknowledged = true;
    if (update.revision !== undefined && update.revision < entry.confirmed.revision) return;
    entry.confirmed = {
      reactions: update.reactions,
      revision: update.revision ?? entry.confirmed.revision,
    };
    this.entries.set(key, entry);
    this.options.confirmed(update);
    this.options.changed();
  }

  toggle(
    conversationId: string,
    messageId: string,
    emoji: string,
    stored: readonly string[],
    revision = 0,
  ): void {
    if (this.disposed) return;
    const key = keyOf(conversationId, messageId);
    const entry: Entry = this.entries.get(key) ?? {
      confirmed: { reactions: stored, revision },
      desired: new Map(),
    };
    if (revision > entry.confirmed.revision) entry.confirmed = { reactions: stored, revision };
    this.entries.set(key, entry);
    const active = !this.reactionsOf(conversationId, messageId, stored, revision).includes(emoji);
    entry.desired.set(emoji, { active, sequence: ++this.sequence });
    this.options.changed();
    if (!entry.running) void this.drain(entry, conversationId, messageId);
  }

  private async drain(entry: Entry, conversationId: string, messageId: string): Promise<void> {
    while (!this.disposed && entry.desired.size > 0) {
      const next = [...entry.desired].sort((a, b) => a[1].sequence - b[1].sequence)[0];
      if (!next) return;
      const [emoji, intent] = next;
      const mutation = {
        conversationId,
        messageId,
        emoji,
        active: intent.active,
        mutationId: createRandomUuid(),
      };
      const running = { mutation, acknowledged: false };
      entry.running = running;
      let failure = false;
      const revisionBeforeSend = entry.confirmed.revision;
      try {
        const update = await this.options.send(mutation);
        if (this.disposed) return;
        // A legacy acknowledgement has no ordering metadata. A newer socket
        // revision received meanwhile takes precedence over that answer.
        if (update.revision !== undefined || entry.confirmed.revision === revisionBeforeSend) {
          this.receive(update);
        }
      } catch {
        if (this.disposed) return;
        // Socket delivery proves commitment even if its HTTP answer was lost.
        // Never replay an ambiguous POST: a rolling release may still have
        // legacy toggle-only workers, even after another worker sent a revision.
        failure = !running.acknowledged;
      }
      if (entry.desired.get(emoji)?.sequence === intent.sequence) {
        entry.desired.delete(emoji);
        if (failure) this.options.failed();
      }
      entry.running = undefined;
      this.options.changed();
    }
  }
}
