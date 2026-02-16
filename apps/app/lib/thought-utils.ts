import type { ToolInvocation } from '@/lib/types/messages';
import { getToolLabel } from '@/lib/tool-registry';

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
 * Extract unique sources from tool invocations (googleSearch, webScraper).
 */
export function extractSources(toolInvocations?: ToolInvocation[]): Source[] {
  if (!toolInvocations) return [];

  const seen = new Set<string>();
  const sources: Source[] = [];

  for (const inv of toolInvocations) {
    if (inv.state !== 'result' || !inv.result) continue;

    if (inv.toolName === 'googleSearch' && Array.isArray(inv.result.results)) {
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
      if (inv.toolName === 'googleSearch' && inv.state === 'result' && inv.result?.results) {
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
