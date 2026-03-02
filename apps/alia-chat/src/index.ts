// @alia.onl/sdk — Alia AI Chat SDK
// Reusable bottom sheet chat component for any Oxy ecosystem app

// Main component
export { AliaChatSheet } from './components/AliaChatSheet';
export type { AliaChatSheetProps, AliaChatSheetRef } from './components/AliaChatSheet';

// Hook (for custom UIs)
export { useAliaChat } from './hooks/useAliaChat';
export type { UseAliaChatOptions, UseAliaChatReturn } from './hooks/useAliaChat';

// Types
export type { ChatMessage, ToolInvocation, AliaChatSuggestion } from './types';

// Theme
export { useAliaColors } from './theme';
export type { AliaColors } from './theme';
