export { EventStream, type EventStreamEntry, type EventType } from './event-stream.js';
export { AgentStateMachine, type AgentState, type TransitionEvent } from './state-machine.js';
export { TodoManager, type TodoItem, type TodoList, type TodoStatus } from './todo-manager.js';
export { applyToolPrefixes, filterToolsByPrefixes, getToolPrefix, groupToolsByPrefix, TOOL_RENAME_MAP, TOOL_PREFIXES } from './tool-router.js';
export { WorkspaceMemory } from './workspace-memory.js';

// Consolidated agent modules (moved from lib/ root)
export { runAgentSession, getRecentActivity } from './runner.js';
export { formatSoul, evolveAgentSoul, type AgentSoul } from './soul.js';
export { buildAgentTools, cleanupSessionResources, type BuildToolsContext } from './tools.js';
