import {
  errorStatus,
  errorMessage as getErrorMessage,
} from '@/shared/api/error-utils';
import { useUpdateAgent } from '@/features/agents/runtime/use-agents';
import { useTranslation } from '@/shared/i18n/use-translation';
import type {
  Agent,
  AgentArchetype,
  ArchetypeConfig,
} from '@/shared/contracts/agents';
import { toast } from '@oxy.so/bloom/toast';
import { useOxy } from '@oxy.so/services';
import { useCallback, useRef, useState } from 'react';

export type LinkedSkill = Agent['skills'][number];
export type LinkedFile = Agent['knowledge'][number];

/**
 * One toast for the whole editor's autosave, reused rather than stacked.
 *
 * The autosave is debounced at a second and fires on every field change, so a
 * toast per save is a toast per pause while somebody writes a prompt — dozens,
 * piling up. Passing the same id replaces the previous one instead, which is
 * what makes the toast an INDICATOR rather than a log.
 *
 * Errors deliberately do NOT carry it. Two saves can be in flight at once (the
 * name goes to Oxy while the tagline goes to Alia), and under a shared id a
 * success arriving second would paint over a failure — which is the exact
 * silence `agents.saveFailed` was added to break.
 */
const SAVE_TOAST_ID = 'agent-editor-save';

/** How long the editor waits after the last edit before it writes. */
const SAVE_DELAY_MS = 1000;

/**
 * The agent's own fields, as the editor holds them while they are being edited.
 *
 * A DRAFT, not a cache of the record: the moment somebody types, this and the
 * server's copy disagree, and the whole point of the screen is that this one
 * wins until it is written. Which is why nothing re-seeds it — the editor is
 * keyed on the agent, see `app/(app)/agents/edit/[id].tsx`.
 *
 * `price` is the string the field holds rather than the number the API takes:
 * `"12."` is a legitimate thing to be halfway through typing and is not a
 * number, so the parse happens at the boundary, once, in the save.
 */
export interface AgentDraft {
  tagline: string;
  description: string;
  systemPrompt: string;
  category: string;
  tags: string[];
  capabilityGrants: string[];
  skills: LinkedSkill[];
  knowledge: LinkedFile[];
  price: string;
  access: 'private' | 'public';
  archetype: AgentArchetype;
  archetypeConfig: ArchetypeConfig;
  /** `publisher/model`, or `null` for the server's default. */
  modelId: string | null;
}

/**
 * The three fields that belong to the agent's Oxy bot ACCOUNT rather than to
 * its Alia row, so they are written to a different service by a different call.
 */
export interface IdentityDraft {
  name: string;
  handle: string;
  color: string | null;
}

/** The draft an agent opens with. Seeded once; see {@link AgentDraft}. */
export function agentDraftFrom(agent: Agent): AgentDraft {
  return {
    tagline: agent.tagline,
    description: agent.description,
    systemPrompt: agent.systemPrompt || '',
    category: agent.category,
    tags: agent.tags || [],
    capabilityGrants: agent.capabilityGrants || [],
    skills: agent.skills || [],
    knowledge: agent.knowledge || [],
    price: agent.price != null ? String(agent.price) : '',
    access: agent.access,
    archetype: agent.archetype || 'general',
    archetypeConfig: agent.archetypeConfig || {},
    modelId: agent.modelId ?? null,
  };
}

/**
 * The debounce, as one timer per half of the save.
 *
 * NOT cleared on unmount, deliberately: a save scheduled a moment before
 * somebody presses back is a save they asked for, and dropping it is how the
 * name edit used to get lost. Nothing in either callback touches component
 * state, so there is nothing to leak — only a request and a toast.
 */
function useDebouncedWrite<T>(write: (next: T) => Promise<void>) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  return (next: T): void => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void write(next);
    }, SAVE_DELAY_MS);
  };
}

/**
 * The agent row's half of the editor: the draft, and the edit that writes it.
 *
 * `editDraft` is the ONLY way the draft changes, and each call schedules its
 * own write. Nothing observes state in order to write, so no amount of
 * re-rendering can produce a request — which is the property
 * `app/(app)/agents/edit/__tests__/autosave-writes-once.test.tsx` pins.
 *
 * The merged draft is computed at the edit and handed to the timer, so the
 * write carries what was on screen when it was scheduled rather than reading
 * state back later. Re-scheduling is what collapses a burst of typing into one
 * request.
 */
export function useAgentDraftAutosave(agent: Agent) {
  const { t } = useTranslation();
  const updateAgent = useUpdateAgent();
  const [draft, setDraft] = useState<AgentDraft>(() => agentDraftFrom(agent));

  /**
   * Write the draft, and say so.
   *
   * A FAILED save is visible. This used to be `} catch { // silent }` with the
   * store swallowing the error before it too, and under those two swallows
   * every autosave this screen sent was a 400 — `permissions` against a
   * `.strict()` schema that did not name it — on every keystroke. Nothing was
   * saved: not the prompt, not the tagline, not the skills. The UI said "saved"
   * the whole time.
   */
  const saveDraft = useCallback(
    async (next: AgentDraft): Promise<void> => {
      toast.loading(t('agents.saving'), { id: SAVE_TOAST_ID });
      try {
        await updateAgent.mutateAsync({
          id: agent._id,
          updates: {
            tagline: next.tagline,
            description: next.description,
            systemPrompt: next.systemPrompt,
            category: next.category,
            tags: next.tags,
            capabilityGrants: next.capabilityGrants,
            skills: next.skills.map((skill) => skill._id),
            knowledge: next.knowledge.map((file) => file._id),
            price: next.price.trim() ? parseFloat(next.price) : null,
            access: next.access,
            archetype: next.archetype,
            archetypeConfig: next.archetypeConfig,
            modelId: next.modelId,
          },
        });
        toast.success(t('agents.autoSaved'), { id: SAVE_TOAST_ID });
      } catch (error: unknown) {
        // The pending indicator goes first: left under its id it would sit
        // there spinning next to the failure it is contradicting.
        toast.dismiss(SAVE_TOAST_ID);
        toast.error(getErrorMessage(error, t('agents.saveFailed')));
      }
    },
    [agent._id, updateAgent.mutateAsync, t],
  );

  const scheduleSave = useDebouncedWrite(saveDraft);

  /** An edit, which is the ONLY thing that writes. */
  const editDraft = (patch: Partial<AgentDraft>): void => {
    const next = { ...draft, ...patch };
    setDraft(next);
    scheduleSave(next);
  };

  return { draft, editDraft };
}

/**
 * The bot account's half: the NAME, the HANDLE and the COLOUR, saved to Oxy.
 *
 * Two writes, two services — not one call that fans out, because a failed
 * rename must not take the tagline with it and a failed tagline must not roll
 * back a rename. `updateAccount` sweeps Oxy's own identity caches, so the
 * profile surfaces do not serve the old name for a TTL afterwards.
 *
 * The colour belongs on this side of that split for the same reason the name
 * does: it is the agent's identity, it lives in `User.color` on the bot
 * account, and Alia stores no column for it.
 */
export function useAgentIdentityAutosave(agent: Agent) {
  const { t } = useTranslation();
  const { oxyServices } = useOxy();
  const [identity, setIdentity] = useState<IdentityDraft>(() => ({
    name: agent.name ?? '',
    handle: agent.handle ?? '',
    color: agent.color,
  }));

  /** What Oxy last confirmed, so a rejected rename can be put back. */
  const savedHandle = useRef(agent.handle ?? '');
  /** The colour Oxy already holds, so a save only carries one that CHANGED. */
  const savedColor = useRef(agent.color);

  const saveIdentity = useCallback(
    async (next: IdentityDraft): Promise<void> => {
      toast.loading(t('agents.saving'), { id: SAVE_TOAST_ID });
      const trimmed = next.handle.trim();
      const handleChanged = trimmed !== savedHandle.current && trimmed !== '';

      /**
       * Ask Oxy whether the handle is free BEFORE writing it, and only when the
       * handle actually CHANGED — the condition the write itself applies. One
       * question per pause, never one per keystroke, and none at all while
       * somebody is editing the name.
       *
       * This is UX, not correctness. Between this answer and the write there is
       * a window in which somebody else can take the name, so the AUTHORITY
       * stays where it was: the 409 below. A design that trusted this instead
       * would be a check-then-insert with a friendlier name.
       *
       * Which is also why a failure here is not a refusal. If Oxy cannot answer,
       * the save goes ahead and the server decides — degrading to "I don't know"
       * is right, degrading to "you may not" is not.
       */
      if (handleChanged) {
        /**
         * An unanswerable check reads as "free", so the save goes ahead and the
         * server decides. Measured against Oxy answering 500: the SDK retries
         * four times with backoff, and the write lands about nine seconds later
         * carrying the username — the degradation is correct, and slow, and the
         * pending toast sits there for those nine seconds.
         *
         * `try`/`await` rather than `.catch()` on the promise. Both were
         * measured and behave identically here, because the SDK rejects rather
         * than throwing; this form is the one that would also survive a version
         * that throws.
         */
        let free = true;
        try {
          free = (await oxyServices.checkUsernameAvailability(trimmed))
            .available;
        } catch {
          free = true;
        }

        if (!free) {
          toast.dismiss(SAVE_TOAST_ID);
          // A rollback, so it goes through `setIdentity` rather than
          // `editIdentity`: putting the old handle back is not an edit and must
          // not schedule a write of its own.
          setIdentity((prev) => ({ ...prev, handle: savedHandle.current }));
          toast.error(t('agents.handleTaken'));
          return;
        }
      }

      try {
        await oxyServices.updateAccount(agent.oxyAccountId, {
          name: { displayName: next.name },
          // Only when it actually changed: `username` is globally unique, and
          // re-sending the current one on every keystroke of the NAME field
          // would ask Oxy to re-check a handle nobody touched.
          ...(handleChanged && { username: trimmed }),
          // Same rule as the handle, for a different reason: `color` is
          // absent-means-unchanged on `UpdateAccountInput`, so sending the
          // current one on every keystroke of the NAME field would write a
          // value nobody touched.
          ...(next.color !== savedColor.current &&
            next.color !== null && { color: next.color }),
        });
        savedHandle.current = trimmed;
        savedColor.current = next.color;
        toast.success(t('agents.autoSaved'), { id: SAVE_TOAST_ID });
      } catch (error: unknown) {
        toast.dismiss(SAVE_TOAST_ID);
        // A taken handle is the one failure worth saying out loud: the field
        // still shows what the person typed, and without this it silently
        // reverts on the next load with nothing to explain it.
        //
        // Still here, and still the authority. The check above only makes the
        // answer arrive sooner and more often; it cannot make this unreachable,
        // because the name can be taken in the moment between the two.
        if (errorStatus(error) === 409) {
          setIdentity((prev) => ({ ...prev, handle: savedHandle.current }));
          toast.error(t('agents.handleTaken'));
        } else {
          // This used to stay silent, on the reasoning that an autosave raising
          // a toast per keystroke-shaped failure is worse than one that does
          // not. The pending state is a toast now, so silence stopped being
          // neutral: the "Saving…" would simply vanish, which reads as saved.
          toast.error(getErrorMessage(error, t('agents.saveFailed')));
        }
      }
    },
    [agent.oxyAccountId, oxyServices, t],
  );

  const scheduleSave = useDebouncedWrite(saveIdentity);

  const editIdentity = (patch: Partial<IdentityDraft>): void => {
    const next = { ...identity, ...patch };
    setIdentity(next);
    scheduleSave(next);
  };

  return { identity, editIdentity };
}
