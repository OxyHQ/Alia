import type { ChatHook, ChatHookContext, AfterChatContext, ChatHookResult } from './types.js';
import { log } from '../logger.js';

const hooks: ChatHook[] = [];

const DEFAULT_PRIORITY = 100;

/**
 * Return a shallow copy of hooks sorted by priority (lower number = runs first).
 * Hooks without an explicit priority default to 100.
 */
function sortedHooks(): ChatHook[] {
  return [...hooks].sort(
    (a, b) => (a.priority ?? DEFAULT_PRIORITY) - (b.priority ?? DEFAULT_PRIORITY),
  );
}

export function registerHook(hook: ChatHook): void {
  hooks.push(hook);
  log.chat.info({ hookName: hook.name, priority: hook.priority }, 'Registered hook');
}

export async function runBeforeChatHooks(ctx: ChatHookContext): Promise<ChatHookResult> {
  let result: ChatHookResult = {};
  for (const hook of sortedHooks()) {
    if (hook.beforeChat) {
      try {
        const hookResult = await hook.beforeChat(ctx);
        if (hookResult) {
          if (hookResult.messages) result.messages = hookResult.messages;
          if (hookResult.metadata) result.metadata = { ...result.metadata, ...hookResult.metadata };
        }
      } catch (error) {
        log.chat.error({ err: error }, 'Error in beforeChat hook "${hook.name}"');
      }
    }
  }
  return result;
}

export async function runAfterChatHooks(ctx: AfterChatContext): Promise<void> {
  for (const hook of sortedHooks()) {
    if (hook.afterChat) {
      try {
        await hook.afterChat(ctx);
      } catch (error) {
        log.chat.error({ err: error }, 'Error in afterChat hook "${hook.name}"');
      }
    }
  }
}
