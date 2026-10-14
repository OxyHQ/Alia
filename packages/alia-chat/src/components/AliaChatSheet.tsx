import { BottomSheet, type BottomSheetRef } from '@oxy.so/bloom/bottom-sheet';
import { forwardRef, useCallback, useImperativeHandle, useRef } from 'react';
import { useColorScheme, View } from 'react-native';
import type { AliaChatLabels } from '../lib/labels';
import type { VoiceSessionComponent } from '../types';
import { AliaChatContent } from './AliaChatContent';
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
      suggestionMatches,
      onSuggestionQuery,
      isDarkMode,
      voiceSession,
      labels,
    },
    ref,
  ) => {
    const isDark = useColorScheme() === 'dark';
    const sheetRef = useRef<BottomSheetRef>(null);
    const chatStopRef = useRef<(() => void) | null>(null);

    const stopChat = useCallback(() => {
      chatStopRef.current?.();
    }, []);

    const registerChatStop = useCallback((stop: (() => void) | null) => {
      chatStopRef.current = stop;
    }, []);

    const handleDismiss = useCallback(() => {
      stopChat();
      sheetRef.current?.dismiss();
    }, [stopChat]);

    useImperativeHandle(
      ref,
      () => ({ present: () => sheetRef.current?.present(), dismiss: handleDismiss }),
      [handleDismiss],
    );

    // A drag, backdrop press, Back or Escape starts closing here: stop the turn first.
    const onDismissAttempt = useCallback(() => {
      stopChat();
      return true;
    }, [stopChat]);

    return (
      <BottomSheet
        ref={sheetRef}
        detached
        scrollable={false}
        manualActivation
        onDismissAttempt={onDismissAttempt}
        onDismiss={stopChat}
        style={{ maxWidth: 600, alignSelf: 'center', borderRadius: SHEET_RADIUS }}
      >
        <AliaChatContent
          clientContext={clientContext}
          model={model}
          apiUrl={apiUrl}
          welcomeGreeting={welcomeGreeting}
          welcomeSubtitle={welcomeSubtitle}
          welcomeSuggestions={welcomeSuggestions}
          suggestionMatches={suggestionMatches}
          onSuggestionQuery={onSuggestionQuery}
          isDarkMode={isDarkMode ?? isDark}
          voiceSession={voiceSession}
          labels={labels}
          onStopReady={registerChatStop}
          // The top padding clears the 28px drag handle, which Bloom floats over the content
          // instead of reserving room for.
          title={null}
          headerLeading={({ hasMessages, clear, agents }) => (
            <View className="pt-8">
              <AliaChatHeader
                hasMessages={hasMessages}
                agents={agents}
                onClear={clear}
                onClose={handleDismiss}
              />
            </View>
          )}
        />
      </BottomSheet>
    );
  },
);

AliaChatSheet.displayName = 'AliaChatSheet';
