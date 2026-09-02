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
      'Create an editable structured automation after the user asks for recurring, scheduled, or event-driven work.',
      'Select only agents, resources, and exact app catalogue tools that the current capability map exposes.',
      'Use executionMode execute and maximumAutonomy autonomous only when the user explicitly requested unattended actions.',
    ].join(' '),
    inputSchema: createAutomationSchema,
    execute: async (definition) => {
      try {
        const created = await createStructuredAutomation({
          ownerAccountId: userId,
          accessToken,
          definition,
        });
        return { success: true, ...created };
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
