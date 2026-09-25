import { useMemo } from "react";
import { create } from "zustand";
import type { Attachment } from "@/shared/contracts/chat-turn";

/**
 * What a composer is holding before it is sent: the text, the attachments and
 * the turn's own choices (connector, skills). One record per account and
 * composer, and the only place any of it lives.
 *
 * ## Why this replaced three owners
 *
 * The text was `useState` inside each mounted chat screen, the attachments
 * were ONE global list in `global-store.ts`, and a draft handed from elsewhere
 * (a failed send, the memory settings) travelled through a third slot,
 * `composerDraft`, that every mounted screen read on every render and matched
 * against its own id with a sequence number. The drawer keeps each visited
 * chat mounted, so the attachment list was on every one of them at once — a
 * picture added in one chat was sitting in the composer of the next — and
 * nothing reset any of it when the account changed, so profile B was handed
 * profile A's half-written message and files (#608 §4).
 *
 * Now each composer names its draft by {@link DraftTarget}, reads only that
 * one, and a hand-off is a write to the target's record: there is nothing to
 * broadcast and nothing to "consume".
 *
 * ## Accounts
 *
 * The store holds the drafts of ONE account, the one bound by the app layout
 * (`bindAccount`). Moving to a different account, or signing out, drops every
 * draft and releases what their attachments were holding. The one exception
 * is signing IN from signed-out: the drafts carry over, because they were
 * typed by the person now signing in — "continue without an account" leaves
 * a draft that must still be there after the sign-in its send opened (#608
 * §3.2).
 *
 * Every write names the account it was made for ({@link DraftAddress}). A
 * write for an account that is no longer bound — a send that fails after the
 * switch, a picker that resolves after it — is refused and its attachments
 * released, so a slow answer for A cannot land in B's composer.
 *
 * ## Not persisted
 *
 * A picture is a `data:` or `blob:` URL; writing megabytes of base64 into
 * AsyncStorage on every keystroke is not a draft feature worth its cost, and a
 * `blob:` URL does not survive a reload anyway.
 */

/**
 * Which composer: a conversation's id, `null` for the new-chat screen (ghost
 * included — it is the same screen), or a `surface:` name for a screen that
 * asks Alia something outside a chat.
 */
export type DraftTarget = string | null;

/** A draft's owner at the time the address was taken. */
export interface DraftAddress {
  account: string | null;
  target: DraftTarget;
}

export interface ComposerDraft {
  text: string;
  attachments: Attachment[];
  /** The connector chosen for the next turn. */
  mcpServerId: string | null;
  /** The skills chosen for the next turn. */
  skillNames: string[];
  /**
   * Set while the composer is rewriting a turn already sent rather than
   * writing a new one: its send replaces that turn and everything after it.
   * Absent for an ordinary draft.
   */
  editing?: DraftEdit;
}

export type DraftTurn = Pick<ComposerDraft, "mcpServerId" | "skillNames">;

/** What the composer held before an edit took it over, for a cancel to give back. */
export type DraftBeforeEdit = Pick<ComposerDraft, "text" | "mcpServerId" | "skillNames">;

export interface DraftEdit {
  /** The user turn being rewritten. */
  messageId: string;
  before: DraftBeforeEdit;
}

/** The turn an edit loads into the composer: its words and the options it was sent with. */
export interface EditedTurn extends DraftTurn {
  messageId: string;
  text: string;
}

export const EMPTY_DRAFT: ComposerDraft = Object.freeze({
  text: "",
  attachments: [],
  mcpServerId: null,
  skillNames: [],
}) as ComposerDraft;

/**
 * Give back a temporary URL, if this one is temporary.
 *
 * On web both pickers — and a dropped document — hand back
 * `URL.createObjectURL(file)`, which pins the file's bytes in the page until
 * it is revoked. `data:` and `file://` URLs are plain strings: nothing to give
 * back.
 */
export function releaseAttachmentUri(uri: string | undefined): void {
  if (uri === undefined || !uri.startsWith("blob:")) return;
  if (typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function")
    return;
  URL.revokeObjectURL(uri);
}

export function releaseAttachments(attachments: readonly Attachment[]): void {
  for (const attachment of attachments) releaseAttachmentUri(attachment.uri);
}

const keyOf = (target: DraftTarget) => target ?? "";

interface DraftStoreState {
  /** The account whose drafts these are; `null` while signed out. */
  account: string | null;
  drafts: Record<string, ComposerDraft>;

  bindAccount: (userId: string | null) => void;
  /** The address of `target` under the account bound now. */
  address: (target: DraftTarget) => DraftAddress;

  setText: (address: DraftAddress, text: string) => void;
  addAttachment: (address: DraftAddress, attachment: Attachment) => void;
  /** Takes the tile away and releases its URL. */
  removeAttachment: (address: DraftAddress, id: string) => void;
  /** Change the turn's connector and skills, from what the draft holds now. */
  updateTurn: (address: DraftAddress, change: (turn: DraftTurn) => DraftTurn) => void;
  /**
   * Put a draft back — a send that failed, or text another screen hands to a
   * composer. The fields given replace the draft's; attachments given are put
   * back in front of any added since, which are kept.
   */
  restore: (address: DraftAddress, draft: Partial<ComposerDraft>) => void;
  /**
   * Empty the draft for a send. The attachments are NOT released: the send
   * still needs them, and a failed one hands them back through `restore`.
   */
  clear: (address: DraftAddress) => void;
  /**
   * Load a sent turn into the composer to be rewritten. What the composer held
   * is kept aside (attachments stay where they are), and a second edit started
   * before the first is sent or cancelled keeps the ORIGINAL draft aside, not
   * the first edit's text.
   */
  startEdit: (address: DraftAddress, turn: EditedTurn) => void;
  /** Leave edit mode and give the composer back what it held before. */
  cancelEdit: (address: DraftAddress) => void;
}

export const useComposerDraftStore = create<DraftStoreState>((set, get) => {
  /** Apply `change` to the target's draft, if the address is still current. */
  const write = (
    address: DraftAddress,
    change: (draft: ComposerDraft) => ComposerDraft | null,
    rejected?: () => void,
  ) => {
    if (address.account !== get().account) {
      rejected?.();
      return;
    }
    set((state) => {
      const key = keyOf(address.target);
      const next = change(state.drafts[key] ?? EMPTY_DRAFT);
      const drafts = { ...state.drafts };
      if (next === null) delete drafts[key];
      else drafts[key] = next;
      return { drafts };
    });
  };

  return {
    account: null,
    drafts: {},

    bindAccount: (userId) => {
      const { account, drafts } = get();
      if (userId === account) return;
      // Signed out -> signed in: the same person, carrying what they typed.
      if (account === null) {
        set({ account: userId });
        return;
      }
      for (const draft of Object.values(drafts)) releaseAttachments(draft.attachments);
      set({ account: userId, drafts: {} });
    },

    address: (target) => ({ account: get().account, target }),

    setText: (address, text) =>
      write(address, (draft) => ({ ...draft, text })),

    addAttachment: (address, attachment) =>
      write(
        address,
        (draft) => ({ ...draft, attachments: [...draft.attachments, attachment] }),
        () => releaseAttachmentUri(attachment.uri),
      ),

    removeAttachment: (address, id) =>
      write(address, (draft) => {
        const removed = draft.attachments.find((a) => a.id === id);
        if (removed === undefined) return draft;
        releaseAttachmentUri(removed.uri);
        return { ...draft, attachments: draft.attachments.filter((a) => a.id !== id) };
      }),

    updateTurn: (address, change) =>
      write(address, (draft) => ({
        ...draft,
        ...change({ mcpServerId: draft.mcpServerId, skillNames: draft.skillNames }),
      })),

    restore: (address, restored) =>
      write(
        address,
        (draft) => {
          const returning = restored.attachments ?? [];
          const ids = new Set(returning.map((a) => a.id));
          return {
            ...draft,
            ...restored,
            attachments: [...returning, ...draft.attachments.filter((a) => !ids.has(a.id))],
          };
        },
        () => releaseAttachments(restored.attachments ?? []),
      ),

    clear: (address) => write(address, () => null),

    startEdit: (address, turn) =>
      write(address, (draft) => ({
        ...draft,
        text: turn.text,
        mcpServerId: turn.mcpServerId,
        skillNames: turn.skillNames,
        editing: {
          messageId: turn.messageId,
          before: draft.editing?.before ?? {
            text: draft.text,
            mcpServerId: draft.mcpServerId,
            skillNames: draft.skillNames,
          },
        },
      })),

    cancelEdit: (address) =>
      write(address, (draft) => {
        if (draft.editing === undefined) return draft;
        const { editing, ...rest } = draft;
        return { ...rest, ...editing.before };
      }),
  };
});

/** The draft of `target`, as a component reads it. */
export function useComposerDraft(target: DraftTarget): ComposerDraft {
  return useComposerDraftStore((state) => state.drafts[keyOf(target)] ?? EMPTY_DRAFT);
}

/** The address of `target` under the account bound now, as a component takes it. */
export function useDraftAddress(target: DraftTarget): DraftAddress {
  const account = useComposerDraftStore((state) => state.account);
  return useMemo(() => ({ account, target }), [account, target]);
}
