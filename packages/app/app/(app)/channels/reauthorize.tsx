import { useTranslation } from '@/shared/i18n/use-translation';
import { StatusSkeleton } from '@/shared/ui/skeletons';
import { useReauthorizeChannels } from '@gemies/sdk/accounts';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiCheckboxCircleLine } from '@oxy.so/bloom/icons/RiCheckboxCircleLine';
import { RiErrorWarningLine } from '@oxy.so/bloom/icons/RiErrorWarningLine';
import { useAuth } from '@oxy.so/services/ui/client';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { ScrollView } from 'react-native';

/**
 * The one tap a channel's notice opens (Gemies `lib/channel-task-authority.ts`): when a connected
 * account, a system bot link or a gemie's Telegram bot can no longer use the person's apps, or is
 * about to stop, the notice links here, and arriving IS the tap. Signed in, every channel of
 * theirs that needs it is renewed at once with their present session (`useReauthorizeChannels`);
 * what still needs them afterwards is said, with another try.
 */
export default function ReauthorizeChannelsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { isAuthenticated, isAuthResolved, signIn } = useAuth();
  const reauthorize = useReauthorizeChannels();
  const started = useRef(false);

  useEffect(() => {
    if (!isAuthResolved) return;
    if (!isAuthenticated) {
      signIn().catch(() => {});
      return;
    }
    if (started.current) return;
    started.current = true;
    reauthorize.mutate();
  }, [isAuthResolved, isAuthenticated, signIn, reauthorize]);

  const answer = reauthorize.data;
  const done = answer !== undefined && answer.failed.length === 0;
  const stillNeeded = reauthorize.isError || (answer !== undefined && answer.failed.length > 0);

  return (
    <ScrollView className="flex-1" contentContainerClassName="gap-4 px-4 pb-6 pt-4">
      <Stack.Screen options={{ title: t('pages.channelReauthorize.title') }} />
      {done ? (
        <EmptyState
          icon={RiCheckboxCircleLine}
          media="circle"
          title={t('pages.channelReauthorize.doneTitle')}
          description={t(
            answer.renewed.length > 0
              ? 'pages.channelReauthorize.doneDescription'
              : 'pages.channelReauthorize.nothingDescription',
          )}
          action={{
            label: t('pages.channelReauthorize.backToChat'),
            onPress: () => router.replace('/'),
          }}
        />
      ) : stillNeeded ? (
        <EmptyState
          icon={RiErrorWarningLine}
          media="circle"
          title={t('pages.channelReauthorize.failedTitle')}
          description={t('pages.channelReauthorize.failedDescription')}
          action={{
            label: t('common.tryAgain'),
            onPress: () => reauthorize.mutate(),
          }}
        />
      ) : (
        // Signing in, or the renewal under way: the shape of its answer, never a spinner.
        <StatusSkeleton />
      )}
    </ScrollView>
  );
}
