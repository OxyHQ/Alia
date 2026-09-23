import React from 'react';
import {
  CheckCircle,
  XCircle,
  Clock,
  Loader2,
  Ban,
} from 'lucide-react-native';
import type { TaskSession } from '@/lib/hooks/use-tasks';

export interface StatusConfig {
  icon: React.ReactElement;
  label: string;
  color: string;
}

export function getStatusConfig(status: TaskSession['status'], colors: { mutedForeground: string }): StatusConfig {
  switch (status) {
    case 'queued':
      return {
        icon: React.createElement(Clock, { size: 12, color: colors.mutedForeground }),
        label: 'Queued',
        color: colors.mutedForeground,
      };
    case 'running':
      return {
        icon: React.createElement(Loader2, { size: 12, color: '#3b82f6' }),
        label: 'Running',
        color: '#3b82f6',
      };
    case 'completed':
      return {
        icon: React.createElement(CheckCircle, { size: 12, color: '#22c55e' }),
        label: 'Completed',
        color: '#22c55e',
      };
    case 'failed':
      return {
        icon: React.createElement(XCircle, { size: 12, color: '#ef4444' }),
        label: 'Failed',
        color: '#ef4444',
      };
    case 'cancelled':
      return {
        icon: React.createElement(Ban, { size: 12, color: colors.mutedForeground }),
        label: 'Cancelled',
        color: colors.mutedForeground,
      };
  }
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
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
