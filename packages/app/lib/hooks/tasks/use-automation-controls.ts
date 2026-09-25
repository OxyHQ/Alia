import type { AutomationDefinition } from '@/lib/automations/types';
import { errorMessage as getErrorMessage } from '@/lib/errors/error-utils';
import {
  useRunAutomation,
  useSetAutomationEnabled,
  useStopAutomation,
} from '@/lib/hooks/use-automations';
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
            `Automation stopped, but ${result.revocation.failed} authorization revocation failed`,
          );
        }
      } catch (error: unknown) {
        toast.error(getErrorMessage(error, 'Failed to update automation'));
      } finally {
        setBusyId(null);
      }
    },
    [setEnabled],
  );

  const stop = useCallback(
    async (automation: AutomationDefinition) => {
      setBusyId(automation.id);
      try {
        const result = await stopAutomation.mutateAsync(automation);
        if (result.revocation?.failed) {
          toast.error(
            `Automation stopped, but ${result.revocation.failed} authorization revocation failed`,
          );
        } else {
          toast.success('Automation stopped and access revoked');
        }
      } catch (error: unknown) {
        toast.error(getErrorMessage(error, 'Failed to stop automation'));
      } finally {
        setBusyId(null);
      }
    },
    [stopAutomation],
  );

  const runNow = useCallback(
    async (automation: AutomationDefinition) => {
      setBusyId(automation.id);
      try {
        await runAutomation.mutateAsync(automation);
        toast.success('Automation queued');
      } catch (error: unknown) {
        toast.error(getErrorMessage(error, 'Automation run failed'));
      } finally {
        setBusyId(null);
      }
    },
    [runAutomation],
  );

  return { busyId, toggleEnabled, stop, runNow };
}
