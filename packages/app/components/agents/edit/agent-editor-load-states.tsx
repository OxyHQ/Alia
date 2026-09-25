import {
  errorStatus,
  errorMessage as getErrorMessage,
} from '@/lib/errors/error-utils';
import { useTranslation } from '@/lib/hooks/use-translation';
import { Button } from '@oxy.so/bloom/button';
import { Loading } from '@oxy.so/bloom/loading';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { Stack } from 'expo-router';
import { View } from 'react-native';

/**
 * The editor's agent could not be loaded.
 *
 * The two answers the route gives are told apart here: a 404 is the route's
 * deliberate "not yours, or not there", which no retry changes, so the way out
 * is the list; anything else is transient and gets a Retry that runs the same
 * query.
 */
export function AgentEditorLoadFailed({
  error,
  onRetry,
  onBackToList,
}: {
  error: unknown;
  onRetry: () => void;
  onBackToList: () => void;
}) {
  const { t } = useTranslation();
  const notFound = errorStatus(error) === 404;

  return (
    <View className="flex-1 items-center justify-center gap-3 p-6">
      <Stack.Screen options={{ headerBackVisible: true }} />
      <Text className="text-center text-base font-semibold leading-[22px] text-foreground">
        {notFound ? t('agents.notFound') : t('agents.loadFailed')}
      </Text>
      <Muted className="text-center text-sm text-muted-foreground">
        {notFound
          ? t('agents.notFoundDetail')
          : getErrorMessage(error, t('agents.loadFailed'))}
      </Muted>
      {notFound ? (
        <Button
          tone="neutral"
          appearance="subtle"
          accessibilityRole="button"
          accessibilityLabel={t('agents.backToAgents')}
          onPress={onBackToList}
        >
          {t('agents.backToAgents')}
        </Button>
      ) : (
        <Button
          tone="neutral"
          appearance="subtle"
          accessibilityRole="button"
          accessibilityLabel={t('agents.retry')}
          onPress={onRetry}
        >
          {t('agents.retry')}
        </Button>
      )}
    </View>
  );
}

/**
 * Waiting for the agent. Either the session is still minting its token — the
 * query is disabled until it has — or the fetch is in flight. Both are a wait,
 * and the same one to the person looking at it.
 */
export function AgentEditorLoading() {
  const { t } = useTranslation();
  return (
    <View className="flex-1 items-center justify-center">
      <Stack.Screen options={{ headerBackVisible: true }} />
      <Loading variant="spinner" text={t('common.loading')} />
    </View>
  );
}
