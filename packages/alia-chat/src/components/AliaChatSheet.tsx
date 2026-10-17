import { AgentAvatarProvider } from '@oxy.so/bloom/agent-avatar';
import { AvatarFlightLayer, useAvatarFlights } from '@oxy.so/bloom/avatar-flight';
import { BottomSheet, type BottomSheetRef } from '@oxy.so/bloom/bottom-sheet';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTheme } from '@oxy.so/bloom/theme';
import { useWindowDimensions, View } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BREAKPOINTS } from '@oxy.so/bloom/styles';
import { ALIA_CHARACTER_RUNTIME_URL } from '../lib/character-runtime';
import type { AliaChatLabels } from '../lib/labels';
import type { AliaToolRenderers } from '../lib/tool-renderers';
import { useShareHandler } from '../hooks/useShareHandler';
import type { AliaRuntimeHost } from '../runtime/config';
import type { AliaHostTools } from '../runtime/host-tools';
import type { AliaConversationShare } from '../runtime/sharing';
import { useThoughtStore } from '../runtime/thought-store';
import type { AliaTurn } from '../hooks/useChatComposer';
import {
  type AliaChatAgentRef,
  AliaChatContent,
  type AliaChatContentProps,
} from './AliaChatContent';
import { AliaChatHeader } from './AliaChatHeader';
import { AliaRecentConversations } from './AliaRecentConversations';
import { ThoughtPanel } from './thought/ThoughtPanel';
import type { AliaSuggestion } from '../types';

/**
 * TODO(bloom): drop this once Bloom's sheet is rounder by default. Its detached
 * sheet hardcodes `radius: 24` (`BottomSheetBase.tsx`, not a design token) and
 * the web fork draws a plain `border-radius`, so 24 reads squarer than the
 * native `smooth` curve it is meant to match. Remove `SHEET_RADIUS` and the
 * `borderRadius` in `style` below when that lands.
 */
const SHEET_RADIUS = 40;

/** How much of the screen's height the sheet of a turn's work takes. */
const THOUGHT_SHEET_HEIGHT = 0.7;

/** The sheet floats (detached) from tablet width up; on a phone it is flush with the screen edges. */
const DETACHED_FROM = BREAKPOINTS.md;

export interface AliaChatSheetProps {
  /** The agent the sheet opens on, any agent the person can reach; omitted, Alia. */
  agent?: AliaChatAgentRef;
  /** App context injected into system prompt */
  clientContext?: string;
  /** The Oxy app this chat is embedded in, by its slug (see `AliaChatContentProps.app`). */
  app?: string;
  /** The UI effects this app performs for the lead (see `AliaChatContentProps.hostTools`). */
  hostTools?: AliaHostTools;
  /** The app's own drawing of catalogue tools' results, keyed `<app>:<tool>`. */
  toolRenderers?: AliaToolRenderers;
  /** The lead's feature gate refused something: show the app's upsell for `key`. */
  onFeatureLocked?: (key: string) => void;
  /** The power level (`auto`, `instant`, `medium`, `high`, `xhigh`, `pro`, `ultra`) or an exact `publisher/model` every turn is sent with; omitted, the server picks. */
  model?: string;
  /** API URL override */
  apiUrl?: string;
  /** Welcome screen greeting */
  welcomeGreeting?: string;
  /** Welcome screen subtitle */
  welcomeSubtitle?: string;
  /** Welcome screen suggestions */
  welcomeSuggestions?: AliaSuggestion[];
  /** What the host found for the typed text, shown over the composer (see `onSuggestionQuery`). */
  suggestionMatches?: AliaSuggestion[];
  /** The typed text, once typing has settled, for the host to search suggestions with. */
  onSuggestionQuery?: (query: string) => void;
  /** Dark-mode flag — forwarded to the ambient wave overlay (defaults to the sheet's own color scheme). */
  isDarkMode?: boolean;
  /** The chat's voice call: on by default, `false` for text only, an object for the host's callbacks. */
  voice?: AliaChatContentProps['voice'];
  /** Overrides for the chat's own copy (header, composer, plan, research…); omitted, English. */
  labels?: Partial<AliaChatLabels>;
  /** Where the 3D avatar's runtime is served from; omitted, Alia's shared copy (`ALIA_CHARACTER_RUNTIME_URL`). */
  characterRuntimeUrl?: string;
  /**
   * Draws the header's share button once there is a conversation; omitted, no share button.
   * Pressed, the conversation's read-only link is minted and handed here for the app to show.
   */
  onShare?: (share: AliaConversationShare) => void;
  /** More rows for the header's menu (`DropdownMenuItem`s from `@oxy.so/bloom/dropdown-menu`). */
  headerMenu?: React.ReactNode;
  /** The person's latest conversations with the lead, under the greeting. Default `true`. */
  recentConversations?: boolean;
}

export interface AliaChatSheetRef {
  /**
   * Opens the sheet. Given a `turn`, the conversation opens over it with that message already
   * sent (an "ask Alia about this" button: a profile, a post, a file); without one, the sheet
   * opens on its welcome, with the composer focused.
   */
  present: (turn?: AliaTurn) => void;
  /** Opens the sheet on a stored conversation with its lead, where the person left it. */
  resume: (conversationId: string) => void;
  /** Closes the sheet and what is stacked on it, stopping a turn still being written. */
  dismiss: () => void;
}

export const AliaChatSheet = forwardRef<AliaChatSheetRef, AliaChatSheetProps>(
  (
    {
      agent,
      app,
      clientContext,
      hostTools,
      toolRenderers,
      onFeatureLocked,
      model,
      apiUrl,
      welcomeGreeting,
      welcomeSubtitle,
      welcomeSuggestions,
      suggestionMatches,
      onSuggestionQuery,
      isDarkMode,
      voice,
      labels,
      characterRuntimeUrl = ALIA_CHARACTER_RUNTIME_URL,
      onShare,
      headerMenu,
      recentConversations = true,
    },
    ref,
  ) => {
    // Bloom's resolved mode, not the system's scheme.
    const { isDark } = useTheme();
    // How far each sheet is presented (0 closed, 1 up): its chat takes the composer's focus at 1.
    const mainProgress = useSharedValue(0);
    const conversationProgress = useSharedValue(0);
    const mainRef = useRef<BottomSheetRef>(null);
    const conversationRef = useRef<BottomSheetRef>(null);
    // Each sheet's chat registers its own canceller; closing a sheet stops its own turn.
    const mainStopRef = useRef<(() => void) | null>(null);
    const conversationStopRef = useRef<(() => void) | null>(null);

    // The conversation sheet, stacked over the main one while a chat is open: begun by a first
    // turn, or a stored one picked up again. The key makes every opening a fresh chat.
    const [conversation, setConversation] = useState<{
      key: number;
      turn?: AliaTurn;
      conversationId?: string;
    } | null>(null);

    const registerMainStop = useCallback((stop: (() => void) | null) => {
      mainStopRef.current = stop;
    }, []);
    const registerConversationStop = useCallback((stop: (() => void) | null) => {
      conversationStopRef.current = stop;
    }, []);

    const startConversation = useCallback((turn: AliaTurn) => {
      setConversation((current) => ({ key: (current?.key ?? 0) + 1, turn }));
    }, []);
    const resumeConversation = useCallback((conversationId: string) => {
      setConversation((current) => ({ key: (current?.key ?? 0) + 1, conversationId }));
    }, []);
    // The chat inside follows its conversation (a first turn creates it, "start over" leaves it).
    const followConversation = useCallback((conversationId: string | undefined) => {
      setConversation((current) => (current ? { ...current, conversationId } : current));
    }, []);
    useEffect(() => {
      if (conversation) conversationRef.current?.present();
    }, [conversation]);

    // Back, and the menu's Clear: close the conversation, back to the main screen underneath.
    const closeConversation = useCallback(() => {
      conversationStopRef.current?.();
      conversationRef.current?.dismiss();
    }, []);
    const onConversationDismissAttempt = useCallback(() => {
      conversationStopRef.current?.();
      return true;
    }, []);

    // What a turn did — its steps, its sources, its reasoning — opens in a sheet over the
    // conversation when the reader asks for it. A turn that begins using tools does not open one by
    // itself: on a phone that would cover the answer being written.
    const thoughtRef = useRef<BottomSheetRef>(null);
    const closeThought = useCallback(() => {
      useThoughtStore.getState().close();
      thoughtRef.current?.dismiss();
    }, []);
    const runtime = useMemo<AliaRuntimeHost>(
      () => ({
        showThought: (opening) => {
          if (opening === 'automatic') return false;
          thoughtRef.current?.present();
          return true;
        },
      }),
      [],
    );

    const handleDismiss = useCallback(() => {
      conversationStopRef.current?.();
      mainStopRef.current?.();
      conversationRef.current?.dismiss();
      mainRef.current?.dismiss();
      closeThought();
    }, [closeThought]);

    useImperativeHandle(
      ref,
      () => ({
        present: (turn) => {
          mainRef.current?.present();
          if (turn) startConversation(turn);
        },
        resume: (conversationId) => {
          mainRef.current?.present();
          resumeConversation(conversationId);
        },
        dismiss: handleDismiss,
      }),
      [handleDismiss, startConversation, resumeConversation],
    );

    // Closing the main sheet (a drag, backdrop press, Back or Escape) closes what is stacked on it.
    const onMainDismissAttempt = useCallback(() => {
      mainStopRef.current?.();
      conversationStopRef.current?.();
      conversationRef.current?.dismiss();
      closeThought();
      return true;
    }, [closeThought]);

    const { width, height } = useWindowDimensions();
    const detached = width >= DETACHED_FROM;
    // Flush with the screen edge the sheet runs behind the home indicator: the composer clears it.
    const { bottom } = useSafeAreaInsets();
    const sheetStyle = detached
      ? { maxWidth: 600, alignSelf: 'center' as const, borderRadius: SHEET_RADIUS }
      : undefined;

    // The avatars fly between the two sheets: one controller, one layer.
    const flights = useAvatarFlights();
    // The conversation's bar: back to the main screen, the participants, share and the menu.
    const share = useShareHandler(onShare);
    const conversationChrome = useCallback<NonNullable<AliaChatContentProps['chrome']>>(
      ({ participants, conversationId }) => ({
        header: (
          <View className="pt-8">
            <AliaChatHeader
              participants={participants}
              hasMessages
              onClear={closeConversation}
              onBack={closeConversation}
              onShare={
                share && conversationId !== undefined ? () => share(conversationId) : undefined
              }
              menu={headerMenu}
            />
          </View>
        ),
      }),
      [closeConversation, share, headerMenu],
    );
    const shared = {
      flights,
      layout: 'sheet' as const,
      agent,
      app,
      clientContext,
      hostTools,
      toolRenderers,
      onFeatureLocked,
      model,
      apiUrl,
      isDarkMode: isDarkMode ?? isDark,
      voice,
      runtime,
      bottomInset: detached ? 0 : bottom,
      labels,
    };

    // The provider wraps the sheets AND the flight layer: both draw avatars, and an avatar drawn
    // outside it would fall back to the host's own `/bloom-character/runtime.mjs`.
    return (
      <AgentAvatarProvider runtimeUrl={characterRuntimeUrl}>
        <BottomSheet
          ref={mainRef}
          detached={detached}
          scrollable={false}
          manualActivation
          animatedProgress={mainProgress}
          onDismissAttempt={onMainDismissAttempt}
          onDismiss={() => setConversation(null)}
          style={sheetStyle}
        >
          {/* The main screen: the greeting, the suggestions and the composer. A first turn opens
              the conversation in its own sheet over this one, so this chat stays empty. */}
          <AliaChatContent
            {...shared}
            welcomeGreeting={welcomeGreeting}
            welcomeSubtitle={welcomeSubtitle}
            welcomeSuggestions={welcomeSuggestions}
            suggestionMatches={suggestionMatches}
            onSuggestionQuery={onSuggestionQuery}
            welcomeAccessory={
              recentConversations ? (
                <AliaRecentConversations agentId={agent?.id} onOpen={resumeConversation} />
              ) : undefined
            }
            presentedProgress={mainProgress}
            onStopReady={registerMainStop}
            onStart={startConversation}
          />
        </BottomSheet>

        {conversation ? (
          <BottomSheet
            key={conversation.key}
            ref={conversationRef}
            detached={detached}
            scrollable={false}
            manualActivation
            animatedProgress={conversationProgress}
            onDismissAttempt={onConversationDismissAttempt}
            onDismiss={() => setConversation(null)}
            style={sheetStyle}
          >
            <AliaChatContent
              {...shared}
              initialTurn={conversation.turn}
              conversationId={conversation.conversationId}
              onConversationChange={followConversation}
              presentedProgress={conversationProgress}
              onStopReady={registerConversationStop}
              chrome={conversationChrome}
            />
          </BottomSheet>
        ) : null}
        <BottomSheet
          ref={thoughtRef}
          detached={detached}
          scrollable={false}
          onDismiss={() => useThoughtStore.getState().close()}
          style={sheetStyle}
        >
          <View style={{ height: height * THOUGHT_SHEET_HEIGHT }}>
            <ThoughtPanel onClose={closeThought} />
          </View>
        </BottomSheet>
        <AvatarFlightLayer flights={flights} />
      </AgentAvatarProvider>
    );
  },
);

AliaChatSheet.displayName = 'AliaChatSheet';
