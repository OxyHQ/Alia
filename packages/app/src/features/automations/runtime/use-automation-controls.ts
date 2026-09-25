import type { AutomationDefinition } from '@/shared/contracts/automations';
import { errorMessage as getErrorMessage } from '@/shared/api/error-utils';
import {
  useRunAutomation,
  useSetAutomationEnabled,
  useStopAutomation,
} from '@/features/automations/runtime/use-automations';
import { useTranslation } from '@/shared/i18n/use-translation';
import { toast } from '@oxy.so/bloom/toast';
import { useCallback, useState } from 'react';

/**
 * An automation's controls in a list: pause/resume, stop, run now.
 *
 * One `busyId` for the whole list, not one per row: while any control is in
 * flight every row's controls are disabled, and the row it belongs to shows
 * it busy.
 */
export function useAutomationControls() {
  const { t } = useTranslation();
  const setEnabled = useSetAutomationEnabled();
  const stopAutomation = useStopAutomation();
  const runAutomation = useRunAutomation();
  const [busyId, setBusyId] = useState<string | null>(null);

  const toggleEnabled = useCallback(
    async (automation: AutomationDefinition, enabled: boolean) => {
      setBusyId(automation.id);
      try {
        const result = await setEnabled.mutateAsync({ automation, enabled });
        if (result.revocation?.failed) {
          toast.error(
            t('automations.controls.revocationFailed', {
              count: result.revocation.failed,
            }),
          );
        }
      } catch (error: unknown) {
        toast.error(getErrorMessage(error, t('automations.controls.updateFailed')));
      } finally {
        setBusyId(null);
      }
    },
    [setEnabled, t],
  );

  const stop = useCallback(
    async (automation: AutomationDefinition) => {
      setBusyId(automation.id);
      try {
        const result = await stopAutomation.mutateAsync(automation);
        if (result.revocation?.failed) {
          toast.error(
            t('automations.controls.revocationFailed', {
              count: result.revocation.failed,
            }),
          );
        } else {
          toast.success(t('automations.controls.stopped'));
        }
      } catch (error: unknown) {
        toast.error(getErrorMessage(error, t('automations.controls.stopFailed')));
      } finally {
        setBusyId(null);
      }
    },
    [stopAutomation, t],
  );

  const runNow = useCallback(
    async (automation: AutomationDefinition) => {
      setBusyId(automation.id);
      try {
        await runAutomation.mutateAsync(automation);
        toast.success(t('automations.controls.queued'));
      } catch (error: unknown) {
        toast.error(getErrorMessage(error, t('automations.controls.runFailed')));
      } finally {
        setBusyId(null);
      }
    },
    [runAutomation, t],
  );

  return { busyId, toggleEnabled, stop, runNow };
}
