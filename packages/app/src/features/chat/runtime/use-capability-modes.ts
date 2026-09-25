/**
 * The three capabilities a person switches on for their turns, and the one
 * place that owns whether each is on.
 *
 * They used to be owned twice. `ChatPageContent` held a component-local
 * `Set<Mode>` that drew the menu's checkmarks, and the global store held the
 * booleans that `use-streaming-chat.ts` reads when it builds the request body.
 * Nothing reconciled them. The drawer keeps a screen mounted and swaps which
 * one is on top, and every genuine unmount — opening a chat from the sidebar
 * after the stack has been popped, a fast refresh, a route that remounts —
 * emptied the `Set` and left the store exactly as it was.
 *
 * So the failure was silent and the wrong way round: agent mode and deep
 * research stayed ON in the payload while the menu drew them OFF. The person
 * had turned them on once and the UI stopped admitting it, which also means
 * they could not turn them off — pressing the row that reads "off" turned it
 * on, and the second press turned it off again. Two presses to undo something
 * the menu said was not happening.
 *
 * This hook is that single owner. It reads the store's three booleans and
 * writes them, so the checkmark is a statement about the next request rather
 * than about the current mount. Toggling it is also where the entitlement
 * check belongs — a capability the plan does not include is never switched on
 * locally first and refused later.
 */

import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { toast } from '@oxy.so/bloom/toast';

import { useStore } from '@/features/chat/runtime/global-store';
import { useEntitlements } from '@/features/billing/runtime/use-billing';
import { useTranslation } from '@/shared/i18n/use-translation';

export type CapabilityMode = 'agent' | 'ghost' | 'deepResearch';

const CAPABILITY_MODE_CONFIG: Record<CapabilityMode, {
  label: string;
  onToast: string;
  offToast: string;
  /** The plan feature this needs, when it needs one. Ghost is free. */
  featureId?: string;
}> = {
  ghost: {
    label: 'modes.ghostLabel',
    onToast: 'modes.ghostOn',
    offToast: 'modes.ghostOff',
  },
  agent: {
    label: 'modes.agentLabel',
    onToast: 'modes.agentOn',
    offToast: 'modes.agentOff',
    featureId: 'agent-mode',
  },
  deepResearch: {
    label: 'modes.deepResearchLabel',
    onToast: 'modes.deepResearchOn',
    offToast: 'modes.deepResearchOff',
    featureId: 'deep-research',
  },
};

export interface CapabilityModes {
  /** What is on right now, straight from the store the request body reads. */
  active: Record<CapabilityMode, boolean>;
  toggle: (mode: CapabilityMode) => void;
}

export function useCapabilityModes(): CapabilityModes {
  const ghost = useStore((state) => state.ghostMode);
  const agent = useStore((state) => state.agentMode);
  const deepResearch = useStore((state) => state.deepResearchMode);
  const { data: entitlements } = useEntitlements();
  const { t } = useTranslation();
  const router = useRouter();

  const toggle = useCallback((mode: CapabilityMode) => {
    const config = CAPABILITY_MODE_CONFIG[mode];
    const store = useStore.getState();
    const current = {
      ghost: store.ghostMode,
      agent: store.agentMode,
      deepResearch: store.deepResearchMode,
    }[mode];

    /**
     * Turning one ON needs the plan; turning one OFF never does. A person
     * whose plan lapsed while a capability was on must still be able to switch
     * it off, and sending them to the subscribe page to do that would trap the
     * flag in the request body.
     */
    if (!current && config.featureId && !entitlements?.features[config.featureId]) {
      toast.info(t('subscribe.featureRequiresPlan', { feature: t(config.label) }));
      router.push('/(biglayout)/subscribe');
      return;
    }

    const next = !current;
    if (mode === 'ghost') store.setGhostMode(next);
    if (mode === 'agent') store.setAgentMode(next);
    if (mode === 'deepResearch') store.setDeepResearchMode(next);

    toast.info(t(next ? config.onToast : config.offToast));
  }, [entitlements, t, router]);

  return {
    active: { ghost, agent, deepResearch },
    toggle,
  };
}
