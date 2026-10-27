/**
 * The stream frames of ADR 0020, read strictly (`docs/agent-embedding.md` §2, §4, §5).
 *
 * A frame is kept only when it has the version and every field the contract names, with the
 * types it names; anything else is not that frame and is dropped whole, never half-applied. Pure:
 * `use-conversation-stream.ts` decides what each one does to the thread.
 */

/** The consulted agent, as `alia.agent_start` names it. */
export interface ConsultAgent {
  id: string;
  name: string;
  handle?: string;
  color?: string;
  character?: unknown;
}

export type ConsultEvent =
  | { type: 'start'; consultId: string; agent: ConsultAgent; task?: string }
  | { type: 'delta'; consultId: string; content: string }
  | {
      type: 'tool';
      consultId: string;
      phase: 'call' | 'result';
      toolCallId: string;
      name: string;
      input?: Record<string, unknown>;
      output?: unknown;
    }
  | {
      type: 'end';
      consultId: string;
      status: 'completed' | 'failed';
      content?: string;
      errorCode?: string;
    };

/** The consult frames' names, the retired `alia.agent` not among them. */
export const CONSULT_EVENTS = [
  'alia.agent_start',
  'alia.agent_delta',
  'alia.agent_tool',
  'alia.agent_end',
] as const;

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
const optionalText = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/** A frame of this contract: version 1 and a consult it belongs to. */
function versioned(data: unknown): (Raw & { consultId: string }) | null {
  if (!isObject(data) || data.eventVersion !== 1 || !isText(data.consultId)) return null;
  return data as Raw & { consultId: string };
}

/** The consult frame `event` carries, or `null` when it is not one or not well-formed. */
export function parseConsultEvent(event: string, data: unknown): ConsultEvent | null {
  const frame = versioned(data);
  if (frame === null) return null;
  const { consultId } = frame;
  switch (event) {
    case 'alia.agent_start': {
      const agent = frame.agent;
      if (!isObject(agent) || !isText(agent.id) || !isText(agent.name)) return null;
      return {
        type: 'start',
        consultId,
        agent: {
          id: agent.id,
          name: agent.name,
          ...(optionalText(agent.handle) ? { handle: agent.handle as string } : {}),
          ...(optionalText(agent.color) ? { color: agent.color as string } : {}),
          ...(agent.character === undefined || agent.character === null
            ? {}
            : { character: agent.character }),
        },
        ...(optionalText(frame.task) ? { task: frame.task as string } : {}),
      };
    }
    case 'alia.agent_delta':
      return typeof frame.content === 'string'
        ? { type: 'delta', consultId, content: frame.content }
        : null;
    case 'alia.agent_tool': {
      const { phase, toolCallId, name, input } = frame;
      if ((phase !== 'call' && phase !== 'result') || !isText(toolCallId) || !isText(name)) {
        return null;
      }
      if (input !== undefined && !isObject(input)) return null;
      return {
        type: 'tool',
        consultId,
        phase,
        toolCallId,
        name,
        ...(input === undefined ? {} : { input }),
        ...(phase === 'result' ? { output: frame.output } : {}),
      };
    }
    case 'alia.agent_end': {
      const { status, content, error } = frame;
      if (status !== 'completed' && status !== 'failed') return null;
      if (content !== undefined && typeof content !== 'string') return null;
      const errorCode = isObject(error) && isText(error.code) ? error.code : undefined;
      return {
        type: 'end',
        consultId,
        status,
        ...(content === undefined ? {} : { content }),
        ...(errorCode === undefined ? {} : { errorCode }),
      };
    }
    default:
      return null;
  }
}

/** A UI effect the model asked the embedding client for (`alia.host_action`). */
export interface HostAction {
  toolCallId: string;
  app: string;
  name: string;
  input: Record<string, unknown>;
  /**
   * The model is waiting for this action's result within the same turn: its outcome is answered
   * at once on the turn's `host-results` route, never with the next request.
   */
  awaitsResult?: true;
  /** The turn that waits, present exactly when `awaitsResult` is. */
  turnId?: string;
}

/** The host action an `alia.host_action` frame carries, or `null` when it is not well-formed. */
export function parseHostAction(data: unknown): HostAction | null {
  if (!isObject(data) || data.eventVersion !== 1) return null;
  const { toolCallId, app, name, input, awaitsResult, turnId } = data;
  if (!isText(toolCallId) || !isText(app) || !isText(name)) return null;
  if (input !== undefined && !isObject(input)) return null;
  if (awaitsResult !== undefined && (awaitsResult !== true || !isText(turnId))) return null;
  return {
    toolCallId,
    app,
    name,
    input: (input as Record<string, unknown> | undefined) ?? {},
    ...(awaitsResult === true ? { awaitsResult: true as const, turnId: turnId as string } : {}),
  };
}

/** The error code that ends a turn an agent's feature gate refused (§5). */
export const FEATURE_ENTITLEMENT_REQUIRED = 'feature_entitlement_required';

/** The feature an error refused, when the error is a feature gate's refusal. */
export function lockedFeatureOf(error: unknown): string | null {
  if (!isObject(error) || error.code !== FEATURE_ENTITLEMENT_REQUIRED) return null;
  return isText(error.feature) ? error.feature : null;
}
