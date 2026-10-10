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
      'Alia is the responsible actor by default: omit actorSelection and Alia runs the task and posts each result into a conversation of its own for the user. Set actorSelection to one of their agents only when the user explicitly asks for that agent; never ask them to pick one.',
      'For reminders, research, or an assistant response, use actions/resources/data-flow as empty arrays; do not fabricate an app or tool. Alia reads the user\'s own Oxy apps (their inbox, notes…) during the task without any connect step, so "summarise my email every morning" needs no declared action.',
      'To be told WHEN something happens ("avísame cuando Meta anuncie algo nuevo", "tell me when this page mentions X"), create a watch instead of a model run every tick: set inputs.watch to { query: "<a web search that would surface it>" } or { url: "<the public page that would change>" }, with condition "change" (default: something new appears) or "contains" plus value (the text to wait for). Use a frequent schedule such as every hour ("0 * * * *"); each tick is a cheap check and Alia only runs when the source changed. Prefer an official URL when one exists, otherwise a precise query.',
      'Connected-app effects (sending, creating, changing something in an Oxy app) are declared as exact actions; Alia runs them herself unless the user named one of their agents.',
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
        log.triggers.error(
          { err: error, ownerAccountId: userId },
          'Failed to create automation via tool',
        );
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });
}
