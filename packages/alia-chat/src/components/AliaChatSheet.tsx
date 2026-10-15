import { AvatarFlightLayer, useAvatarFlights } from '@oxy.so/bloom/avatar-flight';
import { BottomSheet, type BottomSheetRef } from '@oxy.so/bloom/bottom-sheet';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTheme } from '@oxy.so/bloom/theme';
import { useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BREAKPOINTS } from '@oxy.so/bloom/styles';
import type { AliaChatLabels } from '../lib/labels';
import type { VoiceSessionComponent } from '../types';
import { AliaChatContent, type AliaChatContentProps, type AliaTurn } from './AliaChatContent';
import { AliaChatHeader } from './AliaChatHeader';
import type { AliaSuggestion } from '../types';

/**
 * TODO(bloom): drop this once Bloom's sheet is rounder by default. Its detached
 * sheet hardcodes `radius: 24` (`BottomSheetBase.tsx`, not a design token) and
 * the web fork draws a plain `border-radius`, so 24 reads squarer than the
 * native `smooth` curve it is meant to match. Remove `SHEET_RADIUS` and the
 * `borderRadius` in `style` below when that lands.
 */
const SHEET_RADIUS = 40;

/** The sheet floats (detached) from tablet width up; on a phone it is flush with the screen edges. */
const DETACHED_FROM = BREAKPOINTS.md;

export interface AliaChatSheetProps {
  /** App context injected into system prompt */
  clientContext?: string;
  /** Kaana routing profile. Checked against `GET /catalogue`; omitted, the build's preference is used. */
  model?: string;
  /** API URL override */
  apiUrl?: string;
  /** Welcome screen greeting */
  welcomeGreeting?: string;
  /** Welcome screen subtitle */
  welcomeSubtitle?: string;
  /** Welcome screen suggestions */
  welcomeSuggestions?: AliaSuggestion[];
  /** The agents the host knows, with their look: a delegation's thinking avatar is drawn from them until the agent answers. */
  agents?: AliaChatContentProps['agents'];
  /** What the host found for the typed text, shown over the composer (see `onSuggestionQuery`). */
  suggestionMatches?: AliaSuggestion[];
  /** The typed text, once typing has settled, for the host to search suggestions with. */
  onSuggestionQuery?: (query: string) => void;
  /** Dark-mode flag — forwarded to the ambient wave overlay (defaults to the sheet's own color scheme). */
  isDarkMode?: boolean;
  /**
   * Voice capability — pass `VoiceSession` from `@alia.onl/sdk/voice` to offer
   * voice calls. Omitted, the sheet is text-only and `livekit-client` never
   * enters the bundle.
   */
  voiceSession?: VoiceSessionComponent;
  /** Overrides for the chat's own copy (header, composer, plan, research…); omitted, English. */
  labels?: Partial<AliaChatLabels>;
  /** Where the 3D avatar's runtime is served from; omitted, Alia's shared copy (`ALIA_CHARACTER_RUNTIME_URL`). */
  characterRuntimeUrl?: string;
  /** Draws the header's share button once there is a conversation; omitted, no share button. */
  onShare?: () => void;
  /** More rows for the header's menu (`DropdownMenuItem`s from `@oxy.so/bloom/dropdown-menu`). */
  headerMenu?: React.ReactNode;
}

export interface AliaChatSheetRef {
  present: () => void;
  dismiss: () => void;
}

export const AliaChatSheet = forwardRef<AliaChatSheetRef, AliaChatSheetProps>(
  (
    {
      clientContext,
      model,
      apiUrl,
      welcomeGreeting,
      welcomeSubtitle,
      welcomeSuggestions,
      agents,
      suggestionMatches,
      onSuggestionQuery,
      isDarkMode,
      voiceSession,
      labels,
      characterRuntimeUrl,
      onShare,
      headerMenu,
    },
    ref,
  ) => {
    // Bloom's resolved mode, not the system's scheme.
    const { isDark } = useTheme();
    const mainRef = useRef<BottomSheetRef>(null);
    const conversationRef = useRef<BottomSheetRef>(null);
    // Each sheet's chat registers its own canceller; closing a sheet stops its own turn.
    const mainStopRef = useRef<(() => void) | null>(null);
    const conversationStopRef = useRef<(() => void) | null>(null);

    // The conversation sheet, stacked over the main one while a chat is open. The key makes
    // every conversation a fresh chat.
    const [conversation, setConversation] = useState<{ key: number; turn: AliaTurn } | null>(null);

    const registerMainStop = useCallback((stop: (() => void) | null) => {
      mainStopRef.current = stop;
    }, []);
    const registerConversationStop = useCallback((stop: (() => void) | null) => {
      conversationStopRef.current = stop;
    }, []);

    const startConversation = useCallback((turn: AliaTurn) => {
      setConversation((current) => ({ key: (current?.key ?? 0) + 1, turn }));
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

    const handleDismiss = useCallback(() => {
      conversationStopRef.current?.();
      mainStopRef.current?.();
      conversationRef.current?.dismiss();
      mainRef.current?.dismiss();
    }, []);

    useImperativeHandle(
      ref,
      () => ({ present: () => mainRef.current?.present(), dismiss: handleDismiss }),
      [handleDismiss],
    );

    // Closing the main sheet (a drag, backdrop press, Back or Escape) closes what is stacked on it.
    const onMainDismissAttempt = useCallback(() => {
      mainStopRef.current?.();
      conversationStopRef.current?.();
      conversationRef.current?.dismiss();
      return true;
    }, []);

    const { width } = useWindowDimensions();
    const detached = width >= DETACHED_FROM;
    // Flush with the screen edge the sheet runs behind the home indicator: the composer clears it.
    const { bottom } = useSafeAreaInsets();
    const sheetStyle = detached
      ? { maxWidth: 600, alignSelf: 'center' as const, borderRadius: SHEET_RADIUS }
      : undefined;

    // The avatars fly between the two sheets: one controller, one layer.
    const flights = useAvatarFlights();
    const shared = {
      flights,
      clientContext,
      model,
      apiUrl,
      isDarkMode: isDarkMode ?? isDark,
      voiceSession,
      bottomInset: detached ? 0 : bottom,
      labels,
      characterRuntimeUrl,
    };

    return (
      <>
        <BottomSheet
          ref={mainRef}
          detached={detached}
          scrollable={false}
          manualActivation
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
            agents={agents}
            suggestionMatches={suggestionMatches}
            onSuggestionQuery={onSuggestionQuery}
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
            onDismissAttempt={onConversationDismissAttempt}
            onDismiss={() => setConversation(null)}
            style={sheetStyle}
          >
            <AliaChatContent
              {...shared}
              initialTurn={conversation.turn}
              agents={agents}
              onStopReady={registerConversationStop}
              // The bar is the conversation's: back to the main screen, the profile, share and
              // the menu.
              header={({ agents }) => (
                <View className="pt-8">
                  <AliaChatHeader
                    hasMessages
                    agents={agents}
                    onClear={closeConversation}
                    onBack={closeConversation}
                    onShare={onShare}
                    menu={headerMenu}
                  />
                </View>
              )}
            />
          </BottomSheet>
        ) : null}
        <AvatarFlightLayer flights={flights} />
      </>
    );
  },
);

AliaChatSheet.displayName = 'AliaChatSheet';
