/**
 * Full-screen Alia chat component for use as a route/screen in Oxy ecosystem apps.
 *
 * Usage:
 * ```tsx
 * import { AliaChatScreen } from '@alia.onl/sdk';
 *
 * <AliaChatScreen
 *   clientContext="Notes app — user is viewing note #42"
 *   suggestions={[{ label: 'Summarize', prompt: 'Summarize this note' }]}
 *   headerLeft={<BackButton />}
 * />
 * ```
 *
 * Voice is part of the screen: the button, the call bar, the notices and the transcript in the
 * thread. `voice={false}` makes it text-only; `voice={{ canStartVoice, onCallEnded, … }}` brings
 * the host's own callbacks. The call loads on the first one.
 */

import type React from 'react';
import { useCallback } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AgentAvatarProvider } from '@oxy.so/bloom/agent-avatar';
import { ALIA_CHARACTER_RUNTIME_URL } from '../lib/character-runtime';
import { KeyboardAvoidingView } from '../lib/keyboard';
import {
  type AliaChatAgentRef,
  AliaChatContent,
  type AliaChatContentProps,
} from './AliaChatContent';
import { AliaChatHeader } from './AliaChatHeader';
import type { AliaSuggestion } from '../types';
import type { AliaChatLabels } from '../lib/labels';
import type { AliaToolRenderers } from '../lib/tool-renderers';
import { useShareHandler } from '../hooks/useShareHandler';
import type { AliaHostTools } from '../runtime/host-tools';
import type { AliaConversationShare } from '../runtime/sharing';

export interface AliaChatScreenProps {
  /** The agent the screen is with, any agent the person can reach; omitted, Alia. */
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
  /** Draws the header's back button; omit where there is nowhere to go back to. */
  onBack?: () => void;
  /** Optional header left content instead of the back button (e.g. a drawer's menu button) */
  headerLeft?: React.ReactNode;
  /**
   * Draws the header's share button once there is a conversation; omitted, no share button.
   * Pressed, the conversation's read-only link is minted and handed here for the app to show.
   */
  onShare?: (share: AliaConversationShare) => void;
  /** More rows for the header's menu (`DropdownMenuItem`s from `@oxy.so/bloom/dropdown-menu`). */
  headerMenu?: React.ReactNode;
  /** Optional header right action (e.g., settings button) */
  headerRight?: React.ReactNode;
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
  /** Dark-mode flag — forwarded to the ambient wave overlay. */
  isDarkMode?: boolean;
  /** The chat's voice call: on by default, `false` for text only, an object for the host's callbacks. */
  voice?: AliaChatContentProps['voice'];
  /** Overrides for the chat's own copy (header, composer, plan, research…); omitted, English. */
  labels?: Partial<AliaChatLabels>;
  /** Where the 3D avatar's runtime is served from; omitted, Alia's shared copy (`ALIA_CHARACTER_RUNTIME_URL`). */
  characterRuntimeUrl?: string;
}

export function AliaChatScreen({
  agent,
  app,
  clientContext,
  hostTools,
  toolRenderers,
  onFeatureLocked,
  model,
  apiUrl,
  onBack,
  headerLeft,
  onShare,
  headerMenu,
  headerRight,
  welcomeGreeting,
  welcomeSubtitle,
  welcomeSuggestions,
  suggestionMatches,
  onSuggestionQuery,
  isDarkMode,
  voice,
  labels,
  characterRuntimeUrl = ALIA_CHARACTER_RUNTIME_URL,
}: AliaChatScreenProps) {
  const insets = useSafeAreaInsets();
  // The screen owns the whole window, so it keeps its composer out of both
  // system bars: the top inset clears the status bar, the bottom one the
  // gesture bar or home indicator an edge-to-edge app draws over.
  //
  // The keyboard is handled INSIDE the bottom inset. The avoiding view measures
  // its own frame in the window (`automaticOffset`), and that frame already
  // ends `insets.bottom` above the window's edge, so the padding it adds is the
  // keyboard's height minus the inset: the composer sits on the keyboard, not
  // one inset above it. (Its parent-relative layout would read as zero overlap
  // this deep in a host's tree, which is why the offset is measured.)
  const share = useShareHandler(onShare);
  const chrome = useCallback<NonNullable<AliaChatContentProps['chrome']>>(
    ({ hasMessages, startOver, participants, conversationId }) => ({
      header: (
        <AliaChatHeader
          hasMessages={hasMessages}
          participants={participants}
          onClear={startOver}
          onBack={onBack}
          onShare={share && conversationId !== undefined ? () => share(conversationId) : undefined}
          menu={headerMenu}
          leading={headerLeft}
          trailing={headerRight}
        />
      ),
    }),
    [onBack, share, headerMenu, headerLeft, headerRight],
  );

  return (
    <AgentAvatarProvider runtimeUrl={characterRuntimeUrl}>
      <View
        className="flex-1 bg-background-full"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      >
        <KeyboardAvoidingView behavior="padding" automaticOffset style={{ flex: 1 }}>
          <AliaChatContent
            agent={agent}
            app={app}
            clientContext={clientContext}
            hostTools={hostTools}
            toolRenderers={toolRenderers}
            onFeatureLocked={onFeatureLocked}
            model={model}
            apiUrl={apiUrl}
            welcomeGreeting={welcomeGreeting}
            welcomeSubtitle={welcomeSubtitle}
            welcomeSuggestions={welcomeSuggestions}
            suggestionMatches={suggestionMatches}
            onSuggestionQuery={onSuggestionQuery}
            isDarkMode={isDarkMode}
            voice={voice}
            labels={labels}
            chrome={chrome}
          />
        </KeyboardAvoidingView>
      </View>
    </AgentAvatarProvider>
  );
}
