export { runBeforeChatHooks, runAfterChatHooks } from './hook-runner.js';

// Register built-in hooks (side-effect imports)
import './built-in/analytics-hook.js';
import './built-in/memory-recall-hook.js';
import './built-in/style-learning-hook.js';
import './built-in/proactive-hook.js';
