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
  /**
   * The invocation a tool step was built from, so a row can open its input
   * and output in place without a second lookup by position. Only tool steps
   * carry one.
   */
  invocation?: ToolInvocation;
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
        invocation: inv,
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

// ---------------------------------------------------------------------------
// Execution rows (#544): what one tool call reads as, what a turn produced,
// and how long it worked.
// ---------------------------------------------------------------------------

/**
 * How a single tool call reads in an execution row.
 *
 *  - `running`: it has not returned and its turn is still live.
 *  - `done`: it returned, and what it returned was not an error.
 *  - `error`: it returned an error — the tool pipeline reports a throw as a
 *    result carrying `error`, so the call is over but did not succeed.
 *  - `interrupted`: it never returned and its turn is over — a stop, a
 *    failure, or a persisted turn cut short. It must not read as running.
 */
export type ToolCallStatus = 'running' | 'done' | 'error' | 'interrupted';

export function toolCallStatus(inv: Pick<ToolInvocation, 'state' | 'result'>, live: boolean): ToolCallStatus {
  if (inv.state !== 'result') return live ? 'running' : 'interrupted';
  const result: unknown = inv.result;
  if (result !== null && typeof result === 'object' && 'error' in result && Boolean((result as { error?: unknown }).error)) {
    return 'error';
  }
  return 'done';
}

/** Upper bound on the text an expanded row prints for one side of a call. */
export const TOOL_TEXT_LIMIT = 4000;

/**
 * One side of a tool call — its arguments or its result — as text a reader
 * can scan. Strings are printed as they are; anything else is pretty JSON.
 * Long output is cut with a marker rather than hidden, so a row never shows
 * a fragment as if it were the whole.
 */
export function toolCallText(value: unknown, limit = TOOL_TEXT_LIMIT): string {
  if (value === undefined || value === null) return '';
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2) ?? '';
    } catch {
      text = String(value);
    }
  }
  return text.length > limit ? `${text.slice(0, limit)}\n…` : text;
}

/** A file a turn produced, as the Outputs section lists it. */
export interface OutputFile {
  /** The invocation's id, which is also the canvas artifact's id when one was made. */
  id: string;
  name: string;
  toolName: string;
}

/**
 * The files a message's tools generated, read off the same persisted
 * `toolInvocations` the sources come from: a finished `generateFile` names
 * its file, and any tool that returned an `artifact` names that. Nothing is
 * invented for a call that did not return — a running or interrupted
 * generation is a step, not an output.
 */
export function extractOutputs(toolInvocations?: ToolInvocation[]): OutputFile[] {
  if (!toolInvocations) return [];
  const outputs: OutputFile[] = [];
  for (const inv of toolInvocations) {
    if (inv.state !== 'result' || !inv.result || typeof inv.result !== 'object') continue;
    const result = inv.result as { filename?: unknown; title?: unknown; artifact?: { title?: unknown } | null };
    let name: string | null = null;
    if (inv.toolName === 'generateFile') {
      name = typeof result.filename === 'string' && result.filename.length > 0
        ? result.filename
        : typeof result.title === 'string' && result.title.length > 0 ? result.title : getToolLabel(inv.toolName);
    } else if (result.artifact && typeof result.artifact === 'object') {
      name = typeof result.artifact.title === 'string' && result.artifact.title.length > 0
        ? result.artifact.title
        : getToolLabel(inv.toolName);
    }
    if (name === null) continue;
    outputs.push({ id: inv.toolCallId || `output-${outputs.length}`, name, toolName: inv.toolName });
  }
  return outputs;
}

/**
 * When a turn started and, if the conversation says, when it ended — both as
 * epoch milliseconds, `null` where the conversation does not say.
 *
 * The start is the send: the user message before this one carries the
 * client's own stamp (the hook writes it and `POST /conversations` keeps it).
 * The end is the assistant row's stamp, which the server writes when the
 * turn is SAVED — after the model finished — so on a reloaded thread the two
 * bracket the work. A message the client has only just appended carries the
 * send time on both rows, and an older thread saved before clients stamped
 * their sends carries the save time on both; either way the gap is nothing,
 * which is not an elapsed time. Under a second is therefore read as "the
 * conversation does not say", and the live end is observed by the row instead
 * (see `recordTurnEnd`).
 */
export interface TurnTiming {
  startedAt: number | null;
  endedAt: number | null;
}

const MIN_PERSISTED_ELAPSED_MS = 1000;

function stampToMs(stamp: string | undefined): number | null {
  if (stamp === undefined) return null;
  const ms = Date.parse(stamp);
  return Number.isNaN(ms) ? null : ms;
}

export function turnTiming(
  message: { id: string; createdAt?: string },
  messages: ReadonlyArray<{ id: string; role: string; createdAt?: string }>,
): TurnTiming {
  const index = messages.findIndex((m) => m.id === message.id);
  let sendStamp: number | null = null;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      sendStamp = stampToMs(messages[i].createdAt);
      break;
    }
  }
  const ownStamp = stampToMs(message.createdAt);
  const startedAt = sendStamp ?? ownStamp;
  const endedAt =
    sendStamp !== null && ownStamp !== null && ownStamp - sendStamp >= MIN_PERSISTED_ELAPSED_MS ? ownStamp : null;
  return { startedAt, endedAt };
}

/**
 * The moment a turn was SEEN to end on this device, by message id.
 *
 * A locally streamed turn has no persisted end until the thread is reloaded,
 * so the row that watched it settle records the moment here; a row mounted
 * later for the same message — the panel, or the thread after navigating away
 * and back — reads it instead of guessing. Bounded so a long session does not
 * grow it without limit; the oldest entries go first.
 */
const observedTurnEnds = new Map<string, number>();
const OBSERVED_TURN_ENDS_LIMIT = 200;

export function recordTurnEnd(messageId: string, endedAt: number): void {
  if (observedTurnEnds.has(messageId)) return;
  observedTurnEnds.set(messageId, endedAt);
  if (observedTurnEnds.size > OBSERVED_TURN_ENDS_LIMIT) {
    const oldest = observedTurnEnds.keys().next().value;
    if (oldest !== undefined) observedTurnEnds.delete(oldest);
  }
}

export function recordedTurnEnd(messageId: string): number | null {
  return observedTurnEnds.get(messageId) ?? null;
}

/**
 * An elapsed time the way the summary row prints it: `10s`, `1m 5s`, `1h 2m`.
 * `long` spells the units out for an accessible name, where "10s" is read as
 * a letter. Rounded to the second; anything under one reads as `0s`.
 */
export function formatElapsed(ms: number, long = false): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const unit = (n: number, short: string, one: string, many: string): string =>
    long ? `${n} ${n === 1 ? one : many}` : `${n}${short}`;
  if (hours > 0) return `${unit(hours, 'h', 'hour', 'hours')} ${unit(minutes, 'm', 'minute', 'minutes')}`;
  if (minutes > 0) return `${unit(minutes, 'm', 'minute', 'minutes')} ${unit(seconds, 's', 'second', 'seconds')}`;
  return unit(seconds, 's', 'second', 'seconds');
}
