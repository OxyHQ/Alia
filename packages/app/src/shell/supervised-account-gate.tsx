import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { useOxy, useSupervision } from '@oxy.so/services/ui/client';
import type React from 'react';
import { View } from 'react-native';
import { useTranslation } from '@/shared/i18n/use-translation';

/** The supervision states in which Oxy refuses an account's use of the assistant. */
const SUPERVISED_STATUSES: ReadonlySet<string> = new Set(['active', 'orphaned']);

/**
 * Whether the signed-in account is under supervision (oxy ADR 0041).
 *
 * `orphaned` counts: it is supervision with no guardian available, which
 * includes an account created under 13 that still awaits its first guardian
 * (oxy ADR 0067). Anything unknown, including "not loaded yet", is not
 * supervised here: this decides what the app SHOWS, and the refusal itself is
 * Oxy's, made again on every request.
 */
export function isSupervisedStatus(status: string | undefined | null): boolean {
  return typeof status === 'string' && SUPERVISED_STATUSES.has(status);
}

/**
 * Says so, instead of an assistant that answers every message with an error.
 *
 * Oxy refuses inference and agents to a supervised account. Without this the
 * person lands in a chat that looks usable and fails on the first message with
 * a generic "not authorized". The notice names the reason and offers the one
 * thing they can do from here: open Supervision, where an account awaiting a
 * guardian invites one.
 */
export function SupervisedAccountGate({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const { showBottomSheet } = useOxy();
  const supervision = useSupervision();
  if (!isSupervisedStatus(supervision.data?.self?.status)) return children;
  return (
    <View style={{ flex: 1, justifyContent: 'center' }} testID="supervised-account-notice">
      <EmptyState
        media="circle"
        icon={RiLockLine}
        title={t('supervised.title')}
        description={t('supervised.description')}
        action={{
          label: t('supervised.openSupervision'),
          onPress: () => showBottomSheet?.('Supervision'),
          testID: 'supervised-account-open',
        }}
      />
    </View>
  );
}
