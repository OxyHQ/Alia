import type { ToolInvocation } from '@/lib/types/messages';
import type { Message } from '@/lib/hooks/use-conversations';
import type { FailedTurn } from '@/components/chat/turn-failure';
import { getToolLabel } from '@alia.onl/sdk';

export interface Source {
  title: string;
  url: string;
  snippet: string;
  domain: string;
}

export interface ThoughtStep {
  /**
   * `thinking`, `tool` and `writing` are phases of the work; the other four are
   * how it ENDED, and at most one of them closes a list. The panel translates
   * every non-tool type itself — `label` is the English default, kept so a
   * caller without a translator still has something to print.
   */
  type: 'thinking' | 'tool' | 'writing' | 'waiting' | 'done' | 'failed' | 'cancelled';
  label: string;
  toolName?: string;
  sources?: Source[];
  state?: 'partial-call' | 'call' | 'result';
}

/**
 * Where a turn is in its life, as the runtime knows it — never as guessed
 * from what the message happens to contain.
 *
 *  - `queued`: the turn is in flight and nothing has arrived for it yet.
 *  - `running`: tokens, reasoning or tool calls are arriving.
 *  - `waiting_approval`: the run is paused on a tool the person has to allow.
 *  - `completed`: the run ended on its own terms.
 *  - `failed`: the run ended with an error — the failed-turn card is its twin.
 *  - `cancelled`: the person stopped it, or a persisted turn shows a tool that
 *    never returned, which is a run that was interrupted before it finished.
 */
export type TurnLifecycle = 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';

/** The three ways a settled turn can have ended, as stamped on its message. */
export type TurnOutcome = NonNullable<Message['turnOutcome']>;

/**
 * What the streaming runtime knows about the conversation a message sits in.
 *
 * All of it is optional because a message read back from the server after a
 * reload has none of it — and a message with no live context is, by
 * definition, one whose turn is over.
 */
export interface TurnContext {
  /** The hook's `isLoading`: a turn is in flight in THIS conversation. */
  isLoading?: boolean;
  /**
   * The message is the last assistant message of the conversation, which is
   * the one a running turn writes into. Only meaningful with `isLoading`.
   */
  isLastAssistant?: boolean;
  /** The turn that got no answer, if any — its anchor names the failed message. */
  failedTurn?: FailedTurn | null;
}

/** The fields of a message the lifecycle is read from; a `Message` satisfies it. */
export type LifecycleMessage = Pick<
  Message,
  'id' | 'content' | 'thinking' | 'toolInvocations' | 'isStreaming' | 'turnOutcome' | 'pendingApproval' | 'pendingApprovalResult' | 'researchProgress'
>;

/** A tool that was called and never came back — `call` or `partial-call`. */
export function hasUnresolvedTool(message: Pick<LifecycleMessage, 'toolInvocations'>): boolean {
  return message.toolInvocations?.some((inv) => inv.state !== 'result') ?? false;
}

function hasContent(content: LifecycleMessage['content'] | undefined): boolean {
  return typeof content === 'string' ? content.length > 0 : Array.isArray(content) && content.length > 0;
}

/**
 * Anything at all has arrived for the turn: text, reasoning, a tool call, a
 * research phase, or an approval request — which is the run asking a
 * question, and so proof that it started.
 */
function hasAnyOutput(message: LifecycleMessage): boolean {
  return (
    hasContent(message.content) ||
    (message.thinking !== undefined && message.thinking.length > 0) ||
    (message.toolInvocations?.length ?? 0) > 0 ||
    message.researchProgress !== undefined ||
    message.pendingApproval !== undefined
  );
}

/** An approval was asked for and no decision has answered THAT request yet. */
function awaitingApproval(message: LifecycleMessage): boolean {
  const request = message.pendingApproval;
  if (request === undefined) return false;
  return message.pendingApprovalResult?.requestId !== request.requestId;
}

/**
 * The lifecycle of a turn, from the signals the runtime actually tracks.
 *
 * The panel used to decide a turn had ended by looking at whether the message
 * had content — so the first streamed token flipped a running answer to
 * "Done", a finished tool-only turn looked like it was still running, and
 * array content counted as finished the moment it existed. None of those
 * are the turn's state; they are what the message happened to hold.
 *
 * The order here is the order of certainty:
 *
 *  1. A settled outcome on the message, or the failed-turn card anchored on
 *     it, is final — a stream cannot un-fail.
 *  2. Otherwise the turn is live while its message is being streamed into.
 *     `isStreaming` is the hook's own stamp and is trusted on its own, EXCEPT
 *     against an explicit `isLoading: false`: a stamp that outlived the turn
 *     (persisted mid-stream, or left on a voice row) must not run forever.
 *     The `isLoading && isLastAssistant` pair is the fallback for a message
 *     that carries no stamp at all.
 *  3. With no live signal the turn is over. A tool still in `call` then is
 *     one that never returned — an interrupted run, not a finished one.
 */
export function turnLifecycle(message: LifecycleMessage, ctx: TurnContext = {}): TurnLifecycle {
  if (message.turnOutcome === 'failed' || ctx.failedTurn?.anchorMessageId === message.id) return 'failed';
  if (message.turnOutcome === 'cancelled') return 'cancelled';
  if (message.turnOutcome === 'completed') return 'completed';

  const stamped = message.isStreaming === true && ctx.isLoading !== false;
  const inferred = ctx.isLoading === true && ctx.isLastAssistant === true;
  if (stamped || inferred) {
    if (awaitingApproval(message)) return 'waiting_approval';
    return hasAnyOutput(message) ? 'running' : 'queued';
  }

  return hasUnresolvedTool(message) ? 'cancelled' : 'completed';
}

/** The lifecycles during which the panel still animates. */
export function isLiveLifecycle(lifecycle: TurnLifecycle): boolean {
  return lifecycle === 'queued' || lifecycle === 'running' || lifecycle === 'waiting_approval';
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
 * Build an ordered timeline of steps from a message's thinking + tool
 * invocations, closed by the step its lifecycle earns.
 *
 * The closing step is decided by the LIFECYCLE and nothing else: text in the
 * message does not mean the turn is over (it is "Writing" while the turn
 * runs), and a turn that ended in an error or a stop never reads "Done" — it
 * gets its own terminal step. A tool still running is left in its own state
 * so a finished tool before it does not hide it.
 */
export function buildSteps(
  message: Partial<Pick<LifecycleMessage, 'thinking' | 'content' | 'toolInvocations'>>,
  lifecycle: TurnLifecycle,
): ThoughtStep[] {
  const steps: ThoughtStep[] = [];

  // 1. Thinking step — also what a queued turn shows, since a turn with nothing
  //    to show yet is nonetheless being thought about.
  if (message.thinking || lifecycle === 'queued') {
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

  // 3. The step the lifecycle closes the list with.
  switch (lifecycle) {
    case 'queued':
      break;
    case 'running':
      // A tool that has not returned is the live step; otherwise the model is
      // writing, whether or not its first token has been flushed yet.
      if (!hasUnresolvedTool(message)) steps.push({ type: 'writing', label: 'Writing' });
      break;
    case 'waiting_approval':
      steps.push({ type: 'waiting', label: 'Waiting for approval' });
      break;
    case 'completed':
      // "Done" under a message that holds nothing at all would be a step
      // about nothing; a finished tool-only turn, though, is done.
      if (steps.length > 0 || hasContent(message.content)) steps.push({ type: 'done', label: 'Done' });
      break;
    case 'failed':
      steps.push({ type: 'failed', label: 'Failed' });
      break;
    case 'cancelled':
      steps.push({ type: 'cancelled', label: 'Stopped' });
      break;
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
  /** `interrupted` is a tool call that never returned in a turn that is over. */
  status: 'in_progress' | 'complete' | 'interrupted';
  toolName?: string;
  messageId: string;
}

/**
 * Build a chronological audit timeline from all conversation messages.
 *
 * A tool call without a result is "in progress" only while its turn is
 * actually running; in a turn that ended — stopped, failed, or read back from
 * the server that way — it is a call that never returned, and it must not
 * pulse forever.
 */
export function buildAuditTimeline(
  messages: Message[],
  ctx: Omit<TurnContext, 'isLastAssistant'> = {},
): AuditEntry[] {
  const entries: AuditEntry[] = [];
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    const live = isLiveLifecycle(turnLifecycle(msg, { ...ctx, isLastAssistant: msg === lastAssistant }));

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
          status: isDone ? 'complete' : live ? 'in_progress' : 'interrupted',
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
