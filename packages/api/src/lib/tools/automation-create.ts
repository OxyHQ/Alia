import { tool } from 'ai';
import {
  AutomationCreationError,
  createAutomationSchema,
  createStructuredAutomation,
} from '../structured-automation-creation.js';
import { getErrorMessage } from '../errors/index.js';
import { log } from '../logger.js';

/** Create a normalized automation through the same domain service as HTTP. */
export function createAutomationTool(userId: string, accessToken: string | undefined) {
  return tool({
    description: [
      'Create an editable scheduled task only after the user clearly supplies what to do and when to do it.',
      'For reminders, research, or an assistant response, use actions/resources/data-flow as empty arrays and select the responsible owned agent; do not fabricate an app or tool.',
      'For a one-off task, encode its exact local date in the cron day/month fields and set inputs.runOnce to true; it is disabled atomically when that occurrence is claimed.',
      'For connected work, select only human-requested resources and exact app catalogue tools exposed by the current capability map.',
      'Use executionMode execute and maximumAutonomy autonomous for scheduled work. Creation schedules future work; it never runs the task immediately.',
    ].join(' '),
    inputSchema: createAutomationSchema,
    execute: async (definition) => {
      try {
        const created = await createStructuredAutomation({
          ownerAccountId: userId,
          accessToken,
          definition,
        });
        return {
          success: true,
          ...created,
          card: {
            type: 'scheduled-task',
            data: {
              id: created.automation.id,
              objective: created.automation.objective,
              enabled: created.automation.enabled,
              trigger: created.automation.trigger,
            },
          },
        };
      } catch (error: unknown) {
        if (error instanceof AutomationCreationError) {
          return { success: false, error: error.code, ...error.context };
        }
        log.triggers.error({ err: error, ownerAccountId: userId }, 'Failed to create automation via tool');
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });
}
