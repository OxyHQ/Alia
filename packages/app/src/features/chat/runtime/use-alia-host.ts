import { useQueryClient } from '@tanstack/react-query';
import type { Message } from '@gemies/sdk/model';
import type {
  GemieRuntimeHost,
  GemieUsageFrame,
  RoomEvent,
  MessageReactionUpdate,
} from '@gemies/sdk/runtime';
import { resolveFaviconUrl } from '@clarity.surf/sdk';
import { useHaptics } from '@oxy.so/bloom/hooks';
import { usePathname, useRouter } from 'expo-router';
import { useMemo, useRef } from 'react';
import type { CreditsInfo } from '@/features/billing/runtime/use-credits';
import { parseContextUsage } from '@/features/chat/model/context-usage';
import { useStore } from '@/features/chat/runtime/global-store';
import { useModelStore } from '@/features/chat/runtime/model-store';
import type { UsageWarning } from '@/features/chat/runtime/use-credit-warnings';
import { useUIStore } from '@/features/chat/runtime/ui-store';
import { USER_MEMORY_QUERY_KEY } from '@/features/memory/runtime/use-user-data';
import { acquireNotificationsSocket } from '@/features/notifications/runtime/notifications-socket';
import { queryKeys } from '@/shared/api/query-keys';
import { collectDeviceInfo } from '@/shared/platform/device-info';

/** Server tools that mutate the user's memory document (see `packages/api/src/lib/tools/user-memory.ts` in OxyHQ/Gemies). */
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
 * memory and its right panel.
 */
export function useAliaHost(): GemieRuntimeHost {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const haptic = useHaptics();

  // Read when a conversation is opened, not when the host is built: a pathname that changed
  // would otherwise rebuild the host (and re-subscribe every thread) on every navigation.
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  return useMemo<GemieRuntimeHost>(
    () => ({
      deviceInfo: collectDeviceInfo,
      turnRequest: () => ({
        deepResearch: useStore.getState().deepResearchMode,
      }),
      onTurnStart: () => useStore.getState().setBottomChatHeightHandler(true),
      onOutput: () => haptic(),
      onUsage: (usage: GemieUsageFrame) => {
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
      // The work of a turn is read in the right panel. A running turn's first tool opens it only
      // while nothing else is open: a reader who has the canvas up keeps it.
      showThought: (opening) => {
        const ui = useUIStore.getState();
        if (opening === 'automatic' && ui.rightPanel !== null) return false;
        ui.setRightPanel('thought');
        return true;
      },
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
      subscribeConversationReactions: (conversationId, listener) => {
        const { socket, release } = acquireNotificationsSocket();
        const onReaction = (event: MessageReactionUpdate) => {
          if (event?.conversationId === conversationId) listener(event);
        };
        socket.on('conversation:reaction', onReaction);
        return () => {
          socket.off('conversation:reaction', onReaction);
          release();
        };
      },
      // The replies a reaction starts run in the conversation's room.
      subscribeRoomEvents: (conversationId, listener) => {
        const { socket, release } = acquireNotificationsSocket();
        const onGroupEvent = (event: RoomEvent) => {
          if (event?.conversationId === conversationId) listener(event);
        };
        socket.on('group:event', onGroupEvent);
        return () => {
          socket.off('group:event', onGroupEvent);
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
    [queryClient, router, haptic],
  );
}
