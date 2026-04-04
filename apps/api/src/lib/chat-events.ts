export const CHAT_EVENT_VERSION = 1;

export type ClarityChatEventName =
  | 'clarity.research_progress'
  | 'clarity.reasoning'
  | 'clarity.tool_result'
  | 'clarity.title'
  | 'clarity.model_switch';
