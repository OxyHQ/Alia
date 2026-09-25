import { useIsLargeScreen } from '@/lib/hooks/use-is-large-screen';
import { useTranslation } from '@/lib/hooks/use-translation';
import { useLocalRuntimeStore } from '@/lib/stores/local-runtime-store';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth } from '@oxy.so/services';
import { useEffect, useRef, useState } from 'react';

/** One toast for every mounted chat: the drawer keeps visited chats alive. */
export const LOCAL_MODELS_INVITE_TOAST_ID = 'local-models-invite';

/**
 * The one time Alia asks whether it may look for a model on this machine, as
 * a Bloom toast with the two answers on it.
 *
 * ## Why it asks before it looks
 *
 * Detecting first would be one request from the person's own browser to their
 * own machine, and it tells nobody anything — but Chrome is moving toward
 * prompting for local network access itself, and a browser permission dialog
 * arriving with no context is a worse first encounter than a question inside
 * the product. So the product asks, and `use-local-runtime.ts` touches nothing
 * until the answer is `granted`.
 *
 * ## When it may appear
 *
 * - **Only while the chat is on screen** (`enabled`). The caller passes false
 *   while "Meet Alia" owns the container: the toast floats above everything,
 *   and a question about localhost must not bury the product's first sentence
 *   (#608 §3.2). That includes the intro's exit, during which the person is
 *   already signed in.
 * - **Only for somebody signed in.** There is nothing to offer a visitor.
 * - **Only on a large screen.** Granting probes THIS device's `localhost`; a
 *   phone has no model server, so the only possible answer there is no.
 * - **Once.** `inviteSeen` records the asking the moment it is shown, and only
 *   after the store has hydrated — before that `false` means "not read yet",
 *   not "never asked". Dismissing the toast answers nothing: `consent` stays
 *   `unasked`, and Settings › Local models still offers the choice.
 */
export function useLocalModelsInvite(enabled: boolean): void {
  const { t } = useTranslation();
  const { isAuthenticated } = useAuth();
  const isLargeScreen = useIsLargeScreen();
  const consent = useLocalRuntimeStore((state) => state.consent);
  const inviteSeen = useLocalRuntimeStore((state) => state.inviteSeen);
  const [hydrated, setHydrated] = useState(() => useLocalRuntimeStore.persist.hasHydrated());
  useEffect(() => {
    if (hydrated) return;
    // Read again: it may have finished between the render and this effect.
    if (useLocalRuntimeStore.persist.hasHydrated()) setHydrated(true);
    return useLocalRuntimeStore.persist.onFinishHydration(() => setHydrated(true));
  }, [hydrated]);

  const eligible =
    enabled && hydrated && isAuthenticated && isLargeScreen && consent === 'unasked' && !inviteSeen;

  /**
   * Taken back if the chat stops being what is on screen while it is up — a
   * sign-out brings the intro back, and the question must not stay over it.
   */
  const shown = useRef(false);
  const onScreen = enabled && isAuthenticated;
  useEffect(() => {
    if (onScreen || !shown.current) return;
    shown.current = false;
    toast.dismiss(LOCAL_MODELS_INVITE_TOAST_ID);
  }, [onScreen]);

  useEffect(() => {
    if (!eligible) return;
    const store = useLocalRuntimeStore.getState();
    // Another mounted chat may have asked in this same commit.
    if (store.inviteSeen) return;
    store.markInviteSeen();
    shown.current = true;
    const answer = (value: 'granted' | 'declined') => () => {
      useLocalRuntimeStore.getState().setConsent(value);
      toast.dismiss(LOCAL_MODELS_INVITE_TOAST_ID);
    };
    toast(t('models.localInvite.title'), {
      id: LOCAL_MODELS_INVITE_TOAST_ID,
      description: t('models.localInvite.body'),
      // A question waits for its answer; it does not time out on the reader.
      duration: Number.POSITIVE_INFINITY,
      action: { label: t('models.localInvite.accept'), onClick: answer('granted') },
      cancel: { label: t('models.localInvite.decline'), onClick: answer('declined') },
    });
  }, [eligible, t]);
}
