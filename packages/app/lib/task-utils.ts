import type { TaskSession } from '@/lib/hooks/use-tasks';

export function getPlanProgress(task: TaskSession): number | null {
  if (!task.plan?.items?.length) return null;
  const completed = task.plan.items.filter(i => i.status === 'completed').length;
  return Math.round((completed / task.plan.items.length) * 100);
}

export function getTimeLabel(task: TaskSession): string {
  const now = Date.now();

  if (task.status === 'running' && task.stats.startedAt) {
    const elapsed = now - new Date(task.stats.startedAt).getTime();
    return formatDuration(elapsed);
  }

  if (task.stats.completedAt) {
    const ago = now - new Date(task.stats.completedAt).getTime();
    return formatTimeAgo(ago);
  }

  const ago = now - new Date(task.createdAt).getTime();
  return formatTimeAgo(ago);
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatTimeAgo(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const TOOL_PILL_LABELS: Record<string, string> = {
  browse: 'Browsing',
  webSearch: 'Web Search',
  webScraper: 'Reading page',
  generateFile: 'Generating file',
  sendTelegramMessage: 'Telegram',
  sendSlack: 'Slack',
  sendDiscord: 'Discord',
  sendSignal: 'Signal',
  sendEmail: 'Email',
  delegateToAgent: 'Delegating',
  askAgent: 'Asking an agent',
  agentSearch: 'Searching agents',
  userMemory: 'Remembering',
  shellExec: 'Running command',
  fileEdit: 'Editing file',
  codeInterpreter: 'Running code',
};

export function getToolPillLabel(toolName: string): string {
  if (TOOL_PILL_LABELS[toolName]) return TOOL_PILL_LABELS[toolName];

  // Oxy service tools: oxy_serviceName__toolName → "ServiceName"
  if (toolName.startsWith('oxy_')) {
    const parts = toolName.replace('oxy_', '').split('__');
    return parts[0].replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  // Fallback: camelCase → "Camel Case"
  return toolName.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim();
}

/**
 * The finished form of a tool's label, for a task whose call has returned
 * (`TaskList` swaps `runningTitle` for this once the task's steps land).
 * Labels that are already names ("Telegram", "Email") read the same either
 * way, so they fall back to `getToolPillLabel`.
 */
const TOOL_DONE_LABELS: Record<string, string> = {
  browse: 'Browsed',
  webScraper: 'Read page',
  generateFile: 'Generated file',
  delegateToAgent: 'Delegated',
  askAgent: 'Asked an agent',
  agentSearch: 'Searched agents',
  userMemory: 'Remembered',
  shellExec: 'Ran command',
  fileEdit: 'Edited file',
  codeInterpreter: 'Ran code',
};

export function getToolDoneLabel(toolName: string): string {
  return Object.hasOwn(TOOL_DONE_LABELS, toolName) ? TOOL_DONE_LABELS[toolName] : getToolPillLabel(toolName);
}
