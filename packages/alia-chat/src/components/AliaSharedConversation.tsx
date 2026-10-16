/**
 * A conversation somebody shared (`GET /v1/shared/:token`, `docs/agent-embedding.md` §6), read
 * by anybody with the link, signed in or not. It is the SDK's own thread (`AliaThread`), read-only:
 * words, pictures and who wrote them — the server never sends a tool's output, which can hold the
 * person's own data — and nothing to vote on, play, edit or regenerate.
 */

import { AgentAvatarProvider } from '@oxy.so/bloom/agent-avatar';
import type { AiChatThreadHandle } from '@oxy.so/bloom/ai-chat';
import { Loading } from '@oxy.so/bloom/loading';
import { Text } from '@oxy.so/bloom/typography';
import { useMemo, useRef } from 'react';
import { View } from 'react-native';
import { ALIA_CHARACTER_RUNTIME_URL } from '../lib/character-runtime';
import { type AliaChatLabels, AliaChatLabelsProvider, useLabels } from '../lib/labels';
import { AliaRuntimeProvider } from '../runtime/config';
import {
  SharedConversationGoneError,
  sharedMessages,
  useSharedConversation,
} from '../runtime/sharing';
import { AliaThread } from './thread/AliaThread';

export interface AliaSharedConversationProps {
  /** The share link's token. */
  token: string;
  /** Alia's API origin; omitted, production. */
  apiUrl?: string;
  /** Overrides for the chat's own copy; omitted, English. */
  labels?: Partial<AliaChatLabels>;
  /** Where the 3D avatar's runtime is served from; omitted, Alia's shared copy. */
  characterRuntimeUrl?: string;
}

function SharedThread({ token }: { token: string }) {
  const { t } = useLabels();
  const { data, error, isLoading } = useSharedConversation(token);
  const threadRef = useRef<AiChatThreadHandle | null>(null);
  const messages = useMemo(() => (data ? sharedMessages(data) : []), [data]);

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center">
        <Loading />
      </View>
    );
  }
  if (error || !data) {
    return (
      <View className="flex-1 items-center justify-center px-6">
        <Text className="text-center text-base text-muted-foreground">
          {error instanceof SharedConversationGoneError
            ? t('chat.sharedGone')
            : t('chat.sharedFailed')}
        </Text>
      </View>
    );
  }
  return (
    <View className="flex-1">
      {data.title ? (
        <Text className="px-4 pt-4 text-lg font-semibold text-foreground" numberOfLines={2}>
          {data.title}
        </Text>
      ) : null}
      <AliaThread messages={messages} isLoading={false} threadRef={threadRef} readOnly />
    </View>
  );
}

export function AliaSharedConversation({
  token,
  apiUrl,
  labels,
  characterRuntimeUrl = ALIA_CHARACTER_RUNTIME_URL,
}: AliaSharedConversationProps) {
  return (
    <AgentAvatarProvider runtimeUrl={characterRuntimeUrl}>
      <AliaChatLabelsProvider labels={labels}>
        <AliaRuntimeProvider apiUrl={apiUrl}>
          <SharedThread token={token} />
        </AliaRuntimeProvider>
      </AliaChatLabelsProvider>
    </AgentAvatarProvider>
  );
}
