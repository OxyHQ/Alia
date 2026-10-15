import { useQueryClient } from '@tanstack/react-query';
import type { Message } from '@alia.onl/sdk/model';
import type { AliaRuntimeHost, AliaUsageFrame } from '@alia.onl/sdk/runtime';
import { resolveFaviconUrl } from '@clarity.surf/sdk';
import * as Haptics from 'expo-haptics';
import { usePathname, useRouter } from 'expo-router';
import { useMemo, useRef } from 'react';
import type { CreditsInfo } from '@/features/billing/runtime/use-credits';
import { parseContextUsage } from '@/features/chat/model/context-usage';
import { useStore } from '@/features/chat/runtime/global-store';
import { useModelStore } from '@/features/chat/runtime/model-store';
import { useAgentRowPreview } from '@/features/chat/runtime/use-agent-row-preview';
import type { UsageWarning } from '@/features/chat/runtime/use-credit-warnings';
import { useUIStore } from '@/features/chat/runtime/ui-store';
import { USER_MEMORY_QUERY_KEY } from '@/features/memory/runtime/use-user-data';
import { acquireNotificationsSocket } from '@/features/notifications/runtime/notifications-socket';
import { queryKeys } from '@/shared/api/query-keys';
import { collectDeviceInfo } from '@/shared/platform/device-info';

/** Server tools that mutate the user's memory document (see packages/api `lib/tools/user-memory.ts`). */
const MEMORY_WRITING_TOOLS = new Set([
  'saveUserMemory',
  'updateUserMemory',
  'forgetUserMemory',
  'updateUserPreferences',
  'updateUserContext',
]);

/**
 * What the Alia app tells the SDK's conversation runtime about itself.
 *
 * The runtime — transport, cache, streaming, drafts, failed turns — is the SDK's, the same one the
 * bottom sheet runs. This is only what belongs to the app around it: its routes, its credits and
 * memory, its right panel and its sidebar's agent rows.
 */
export function useAliaHost(): AliaRuntimeHost {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const previewAgentRow = useAgentRowPreview();

  // Read when a conversation is opened, not when the host is built: a pathname that changed
  // would otherwise rebuild the host (and re-subscribe every thread) on every navigation.
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  return useMemo<AliaRuntimeHost>(
    () => ({
      deviceInfo: collectDeviceInfo,
      turnRequest: () => ({
        webSearch: useModelStore.getState().webSearch,
        agentMode: useStore.getState().agentMode,
        deepResearch: useStore.getState().deepResearchMode,
      }),
      onTurnStart: () => useStore.getState().setBottomChatHeightHandler(true),
      onOutput: () => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      },
      onUsage: (usage: AliaUsageFrame) => {
        queryClient.setQueryData<CreditsInfo>(queryKeys.credits.info, (old) =>
          old ? { ...old, credits: usage.credits_remaining ?? old.credits } : old,
        );
        // The balance is set from the frame; the rest (the usage window) is refetched.
        void queryClient.invalidateQueries({ queryKey: queryKeys.credits.info });
        // The person's own spending, as the server measured it — shown before a turn
        // fails, by `useCreditWarnings`.
        const warning = usage.credit_warning;
        if (warning && (warning.level === 'warning' || warning.level === 'critical')) {
          queryClient.setQueryData<UsageWarning>(queryKeys.credits.usageWarning, {
            level: warning.level,
            daysRemaining: Number(warning.daysRemaining),
            todaySpend: Number(warning.todaySpend),
            avgDailySpend: Number(warning.avgDailySpend),
            currentModelMultiplier:
              typeof warning.currentModelMultiplier === 'number'
                ? warning.currentModelMultiplier
                : undefined,
          });
        }
      },
      // The assistant just rewrote the memory document, so any screen showing it is out of date.
      onToolResult: ({ name }) => {
        if (name && MEMORY_WRITING_TOOLS.has(name)) {
          void queryClient.invalidateQueries({ queryKey: USER_MEMORY_QUERY_KEY });
        }
      },
      onArtifact: (artifact) => {
        const ui = useUIStore.getState();
        ui.addCanvasArtifact(artifact as Parameters<typeof ui.addCanvasArtifact>[0]);
        ui.setRightPanel('canvas');
      },
      onContext: (conversationId, payload) => {
        const usage = parseContextUsage(payload);
        if (usage) useUIStore.getState().setContextUsage(conversationId, usage);
      },
      onAgentTurn: ({ turnId, agentId, conversationId }) =>
        useUIStore.getState().openAgentPanel(turnId, agentId, conversationId),
      onTurnPreview: previewAgentRow,
      // The work of a turn is read in the right panel. A running turn's first tool opens it only
      // while nothing else is open: a reader who has the canvas up keeps it.
      showThought: (opening) => {
        const ui = useUIStore.getState();
        if (opening === 'automatic' && ui.rightPanel !== null) return false;
        ui.setRightPanel('thought');
        return true;
      },
      openAutomation: (id) => router.push({ pathname: '/(app)/automations/[id]', params: { id } }),
      faviconUrl: resolveFaviconUrl,
      // An agent wrote into THIS conversation on its own (a result, a check-in).
      subscribeConversationMessages: (conversationId, listener) => {
        const { socket, release } = acquireNotificationsSocket();
        const onConversationMessage = (event: { conversationId?: string; message?: Message }) => {
          if (event.conversationId === conversationId && event.message) listener(event.message);
        };
        socket.on('conversation:message', onConversationMessage);
        return () => {
          socket.off('conversation:message', onConversationMessage);
          release();
        };
      },
      // The new-chat screen is replaced by the conversation it started; any other screen
      // (a task described in words) keeps its place in the back stack.
      openConversation: (id) => {
        const target = { pathname: '/(app)/c/[id]', params: { id } } as const;
        if (pathnameRef.current === '/') router.replace(target);
        else router.push(target);
      },
      closeConversation: () => router.replace('/(app)'),
    }),
    [queryClient, previewAgentRow, router],
  );
}
