import type { ToolInvocation } from '@/lib/types/messages';
import { getToolLabel } from '@alia.onl/sdk';

export interface Source {
  title: string;
  url: string;
  snippet: string;
  domain: string;
}

export interface ThoughtStep {
  type: 'thinking' | 'tool' | 'done';
  label: string;
  toolName?: string;
  sources?: Source[];
  state?: 'partial-call' | 'call' | 'result';
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return url;
  }
}

/**
 * Extract unique sources from tool invocations (webSearch, webScraper).
 */
export function extractSources(toolInvocations?: ToolInvocation[]): Source[] {
  if (!toolInvocations) return [];

  const seen = new Set<string>();
  const sources: Source[] = [];

  for (const inv of toolInvocations) {
    if (inv.state !== 'result' || !inv.result) continue;

    if ((inv.toolName === 'webSearch' || (inv.toolName === 'browse' && inv.result.action === 'search')) && Array.isArray(inv.result.results)) {
      for (const r of inv.result.results) {
        if (r.url && !seen.has(r.url)) {
          seen.add(r.url);
          sources.push({
            title: r.title || getDomain(r.url),
            url: r.url,
            snippet: r.snippet || '',
            domain: getDomain(r.url),
          });
        }
      }
    }

    if (inv.toolName === 'browse' && inv.result.action === 'read' && inv.result.url) {
      const url = inv.result.url;
      if (!seen.has(url)) {
        seen.add(url);
        sources.push({
          title: inv.result.title || getDomain(url),
          url,
          snippet: inv.result.content ? inv.result.content.slice(0, 200) : '',
          domain: getDomain(url),
        });
      }
    }

    if (inv.toolName === 'webScraper' && inv.result.url) {
      const url = inv.result.url;
      if (!seen.has(url)) {
        seen.add(url);
        sources.push({
          title: inv.result.title || getDomain(url),
          url,
          snippet: inv.result.content ? inv.result.content.slice(0, 200) : '',
          domain: getDomain(url),
        });
      }
    }
  }

  return sources;
}

/**
 * Build an ordered timeline of steps from a message's thinking + tool invocations.
 */
export function buildSteps(
  message: { thinking?: string; content?: any; toolInvocations?: ToolInvocation[] },
  isStreaming: boolean,
): ThoughtStep[] {
  const steps: ThoughtStep[] = [];

  // 1. Thinking step
  if (message.thinking) {
    steps.push({ type: 'thinking', label: 'Thinking' });
  }

  // 2. Tool invocation steps
  if (message.toolInvocations) {
    for (const inv of message.toolInvocations) {
      const step: ThoughtStep = {
        type: 'tool',
        label: getToolLabel(inv.toolName),
        toolName: inv.toolName,
        state: inv.state,
      };

      // Attach sources for search tools that have results
      if ((inv.toolName === 'webSearch' || (inv.toolName === 'browse' && inv.result?.action === 'search')) && inv.state === 'result' && inv.result?.results) {
        step.sources = inv.result.results
          .filter((r: any) => r.url)
          .map((r: any) => ({
            title: r.title || getDomain(r.url),
            url: r.url,
            snippet: r.snippet || '',
            domain: getDomain(r.url),
          }));
      }

      steps.push(step);
    }
  }

  // 3. Done step (only when message has content and is not streaming)
  const hasContent =
    typeof message.content === 'string'
      ? message.content.length > 0
      : Array.isArray(message.content) && message.content.length > 0;

  if (hasContent && !isStreaming) {
    steps.push({ type: 'done', label: 'Done' });
  }

  return steps;
}

/**
 * Entry in the action audit timeline.
 */
export interface AuditEntry {
  id: string;
  type: 'tool_call' | 'research_phase' | 'agent_delegation' | 'plan_approved' | 'artifact_generated';
  label: string;
  description: string;
  status: 'in_progress' | 'complete';
  toolName?: string;
  messageId: string;
}

/**
 * Build a chronological audit timeline from all conversation messages.
 */
export function buildAuditTimeline(
  messages: Array<{ id: string; role: string; content?: any; toolInvocations?: ToolInvocation[]; agentInfo?: any; [key: string]: any }>
): AuditEntry[] {
  const entries: AuditEntry[] = [];

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;

    // Agent delegation
    if (msg.agentInfo) {
      entries.push({
        id: `agent-${msg.id}`,
        type: 'agent_delegation',
        label: `Agent: ${msg.agentInfo.name}`,
        description: typeof msg.content === 'string' ? msg.content.slice(0, 80) : '',
        status: 'complete',
        messageId: msg.id,
      });
    }

    // Plan approved
    if (msg.pendingPlan?.approved) {
      entries.push({
        id: `plan-${msg.id}`,
        type: 'plan_approved',
        label: 'Plan approved',
        description: `${msg.pendingPlan.steps?.length || 0} steps`,
        status: 'complete',
        messageId: msg.id,
      });
    }

    // Tool invocations
    if (msg.toolInvocations) {
      for (const inv of msg.toolInvocations) {
        const isDone = inv.state === 'result';
        const toolLabel = getToolLabel(inv.toolName);

        let description = '';
        if (inv.args?.query) {
          const q = String(inv.args.query);
          description = q.length > 50 ? q.slice(0, 50) + '...' : q;
        } else if (inv.args?.url) {
          const u = String(inv.args.url);
          description = u.length > 50 ? u.slice(0, 50) + '...' : u;
        }

        entries.push({
          id: inv.toolCallId || `tool-${msg.id}-${inv.toolName}`,
          type: 'tool_call',
          label: toolLabel,
          description,
          status: isDone ? 'complete' : 'in_progress',
          toolName: inv.toolName,
          messageId: msg.id,
        });

        // Artifact generated from generateFile
        if (inv.toolName === 'generateFile' && isDone && inv.result) {
          entries.push({
            id: `artifact-${inv.toolCallId}`,
            type: 'artifact_generated',
            label: 'File generated',
            description: inv.result.filename || inv.result.title || '',
            status: 'complete',
            messageId: msg.id,
          });
        }
      }
    }

    // Research phases
    if (msg.researchProgress) {
      const rp = msg.researchProgress;
      entries.push({
        id: `research-${msg.id}`,
        type: 'research_phase',
        label: rp.isComplete ? 'Research complete' : `Research: ${rp.phase || 'in progress'}`,
        description: rp.message || '',
        status: rp.isComplete ? 'complete' : 'in_progress',
        messageId: msg.id,
      });
    }
  }

  return entries;
}
