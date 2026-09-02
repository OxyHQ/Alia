import { API_ROUTES } from '../api/routes';
import type { AutomationDefinition } from './types';

export type AutomationControlRequest = {
  method: 'DELETE' | 'PATCH' | 'POST';
  path: string;
};

export interface AutomationControlRequests {
  update: AutomationControlRequest;
  stop: AutomationControlRequest;
  run: AutomationControlRequest | null;
}

/**
 * Keeps legacy trigger rows on their original control plane while the UI reads
 * both generations from the normalized automation index.
 */
export function automationControlRequests(
  automation: Pick<AutomationDefinition, 'id' | 'legacyTriggerId' | 'trigger'>,
): AutomationControlRequests {
  if (automation.legacyTriggerId) {
    const path = API_ROUTES.triggers.update(automation.legacyTriggerId);
    return {
      update: { method: 'PATCH', path },
      stop: { method: 'PATCH', path },
      run: { method: 'POST', path: API_ROUTES.triggers.run(automation.legacyTriggerId) },
    };
  }

  return {
    update: { method: 'PATCH', path: API_ROUTES.automations.update(automation.id) },
    stop: { method: 'DELETE', path: API_ROUTES.automations.stop(automation.id) },
    run: automation.trigger.type === 'manual'
      ? { method: 'POST', path: API_ROUTES.automations.run(automation.id) }
      : null,
  };
}
