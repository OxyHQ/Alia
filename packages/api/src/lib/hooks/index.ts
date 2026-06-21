export { registerHook, runBeforeChatHooks, runAfterChatHooks } from './hook-runner.js';
export type { ChatHook, ChatHookContext, AfterChatContext } from './types.js';

// Register built-in hooks (side-effect imports)
import './built-in/analytics-hook.js';
import './built-in/memory-recall-hook.js';
import './built-in/style-learning-hook.js';
import './built-in/proactive-hook.js';
