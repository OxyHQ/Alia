/**
 * Switch Model Tool
 *
 * Lets the AI autonomously switch to a different Alia model
 * when it determines the current question needs different capabilities.
 * Sends a model_switch SSE event so the frontend can update the selector.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getAliaModel } from '../gateway-client.js';
import { log } from '../logger.js';

/**
 * Create a switchModel tool.
 * @param onSwitch Callback fired when the AI switches models — use to send SSE event.
 */
export function createSwitchModelTool(onSwitch: (modelId: string, modelName: string) => void) {
  return tool({
    description:
      'Switch to a different AI model for this conversation. Use when the current question ' +
      'needs capabilities beyond the current model. Available models:\n' +
      '- alia-lite: Fast, simple questions (0.5x credits)\n' +
      '- alia-v1: Balanced, everyday tasks (1x credits)\n' +
      '- alia-v1-pro: Advanced reasoning, complex analysis (3x credits)\n' +
      '- alia-v1-thinking: Deep reasoning with extended thinking (5x credits)\n' +
      '- alia-v1-pro-max: Best available models (5x credits)\n' +
      'Only switch when the task clearly benefits from a different model.',
    inputSchema: z.object({
      model: z.string().describe('Model ID to switch to (e.g. "alia-v1-pro")'),
      reason: z.string().describe('Brief reason for switching'),
    }),
    execute: async ({ model, reason }) => {
      const aliaModel = await getAliaModel(model);
      if (!aliaModel) {
        return { error: `Model "${model}" not found. Available: alia-lite, alia-v1, alia-v1-pro, alia-v1-thinking, alia-v1-pro-max.` };
      }
      if (!aliaModel.chatVisible) {
        return { error: `Model "${model}" is not available for chat.` };
      }

      log.tools.info({ model, modelName: aliaModel.name, reason }, 'AI switched model');
      onSwitch(model, aliaModel.name);

      return {
        switched: true,
        model,
        modelName: aliaModel.name,
        message: `Switched to ${aliaModel.name}. Future messages in this conversation will use this model.`,
      };
    },
  });
}
