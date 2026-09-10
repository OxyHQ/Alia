import type { ToolInvocation } from '@/lib/types/messages';
import type { Message } from '@/lib/hooks/use-conversations';
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
 * The sources of a finished `deepResearch` invocation, as the research
 * handler persists them: `{ id, url, title }[]` under `result.sources`, the
 * same shape the final `alia.research_progress` event carries live. No
 * snippet — research keeps excerpts server-side — so the card shows the
 * title alone.
 */
function researchInvocationSources(result: { sources?: unknown }): Source[] {
  if (!Array.isArray(result.sources)) return [];
  return researchSourcesToSources(result.sources as Array<{ id?: unknown; url?: unknown; title?: unknown }>);
}

/**
 * Research sources — from a persisted invocation or from the live progress
 * event — in the shape the Sources row and panel render. One per URL: the
 * tracker already de-duplicates server-side, and this keeps that true of
 * whatever a row holds.
 */
export function researchSourcesToSources(
  sources?: Array<{ id?: unknown; url?: unknown; title?: unknown }> | null,
): Source[] {
  if (!sources) return [];
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const s of sources) {
    if (!s || typeof s.url !== 'string' || s.url.length === 0 || seen.has(s.url)) continue;
    seen.add(s.url);
    const title = typeof s.title === 'string' && s.title.trim().length > 0 ? s.title.trim() : getDomain(s.url);
    out.push({ title, url: s.url, snippet: '', domain: getDomain(s.url) });
  }
  return out;
}

/** The union of two source lists, first occurrence of a URL winning. */
export function mergeSources(...lists: Source[][]): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const list of lists) {
    for (const source of list) {
      if (seen.has(source.url)) continue;
      seen.add(source.url);
      out.push(source);
    }
  }
  return out;
}

/**
 * Extract unique sources from tool invocations (webSearch, webScraper,
 * browse, and the `deepResearch` record a research answer is saved with).
 */
export function extractSources(toolInvocations?: ToolInvocation[]): Source[] {
  if (!toolInvocations) return [];

  const seen = new Set<string>();
  const sources: Source[] = [];

  for (const inv of toolInvocations) {
    if (inv.state !== 'result' || !inv.result) continue;

    if (inv.toolName === 'deepResearch') {
      for (const source of researchInvocationSources(inv.result)) {
        if (seen.has(source.url)) continue;
        seen.add(source.url);
        sources.push(source);
      }
      continue;
    }

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

      // A research step carries every source the answer was written from.
      if (inv.toolName === 'deepResearch' && inv.state === 'result' && inv.result) {
        const researchSources = researchInvocationSources(inv.result);
        if (researchSources.length > 0) step.sources = researchSources;
      }

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
  messages: Message[]
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

    // Research phases. `failed` is the engine saying the write-up did not
    // happen: finished, not in progress, and not "complete" either.
    if (msg.researchProgress) {
      const rp = msg.researchProgress;
      const failed = rp.phase === 'failed';
      entries.push({
        id: `research-${msg.id}`,
        type: 'research_phase',
        label: failed
          ? 'Research incomplete'
          : rp.isComplete
            ? 'Research complete'
            : `Research: ${rp.phase || 'in progress'}`,
        description: rp.message || '',
        status: rp.isComplete || failed ? 'complete' : 'in_progress',
        messageId: msg.id,
      });
    }
  }

  return entries;
}
