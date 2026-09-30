/**
 * How many tools one inference request may carry, and the guard that keeps a
 * request over it from ever leaving Alia.
 *
 * ## Where 128 comes from
 *
 * The Oxy inference edge validates the public request against
 * `OxyHQServices packages/api/src/schemas/inferenceEdge.schemas.ts`, whose
 * `tools` array is capped at 128 elements. That cap mirrors OpenAI's own
 * per-request maximum of 128 tools, so it is not an Oxy quirk to route around:
 * a request with 129 tools is one no upstream would take. It is the budget, and
 * Alia fits inside it rather than asking for it to grow.
 *
 * ## Why Alia enforces it at all
 *
 * On 2026-09-27 and again on 2026-09-30 (Ref
 * `chatcmpl-f9ff8f2a-ace7-4b64-935f-038b56c79540`) a chat turn assembled 143
 * tools — 93 of them `oxy_mention__*` — and the edge refused the whole request
 * with `400 invalid_request`, `param: "tools"`, "Array must contain at most 128
 * element(s)". The person saw "Alia couldn't answer right now". Nothing in Alia
 * counted: the Oxy service catalogue grew and the turn silently crossed a line
 * it could not see.
 *
 * Two layers stop that now:
 *
 *  1. `lib/tool-budget.ts`, called by `ToolPipeline.forUser`, never hands a
 *     turn more than this many DIRECT tools. What does not fit is deferred
 *     behind `searchTools`/`callTool`, never dropped.
 *  2. {@link assertToolCountWithinLimit}, at the Kaana adapter, refuses any
 *     request that still carries more — a path that bypassed the assembler, a
 *     future caller — with a typed error and a log naming the families, BEFORE
 *     anything is sent. The edge's 400 is unreachable from Alia.
 */

import { OxyInferenceError } from '@oxy.so/core/inference';

import { log } from '../logger.js';

/**
 * The per-request tool ceiling: the Oxy inference edge's `tools` maximum, which
 * is OpenAI's per-request maximum of 128 tools.
 */
export const MAX_TOOLS_PER_INFERENCE_REQUEST = 128;

/**
 * The family a tool name belongs to, for counting and for logs.
 *
 * Instanced tools are named `<kind>_<instance>__<tool>` (`oxy_mention__createPost`,
 * `mcp_github__search`), so the family is everything before the first `__`.
 * Anything else is a single named tool and is its own family — a built-in, an
 * integration, an editor tool.
 */
export function toolFamilyOf(name: string): string {
  const cut = name.indexOf('__');
  return cut > 0 ? name.slice(0, cut) : name;
}

/** Tool counts by family, largest first — what a refusal log needs to be actionable. */
export function toolFamilyCounts(names: readonly string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const name of names) {
    const family = /^(?:oxy|mcp)_/.test(name) ? toolFamilyOf(name) : 'other';
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

/**
 * A request that would carry more tools than one inference request may.
 *
 * An {@link OxyInferenceError} on purpose: the product already maps that type
 * by its `code` (`lib/errors/failover-error.ts`), so this refusal reads exactly
 * as the edge's own `invalid_request` would — non-retryable, a format fault —
 * without a request ever being made. `requestId` is empty because there is no
 * Oxy request to correlate: it never left Alia.
 */
export class ToolLimitExceededError extends OxyInferenceError {
  readonly toolCount: number;
  readonly limit: number;

  constructor(input: { toolCount: number; limit?: number; message?: string }) {
    const limit = input.limit ?? MAX_TOOLS_PER_INFERENCE_REQUEST;
    super({
      code: 'invalid_request',
      message:
        input.message ??
        `This request carries ${input.toolCount} tools; one inference request may carry at most ${limit}.`,
      retryable: false,
      requestId: '',
      status: 400,
      param: 'tools',
    });
    this.name = 'ToolLimitExceededError';
    this.toolCount = input.toolCount;
    this.limit = limit;
  }
}

/**
 * Refuse, before sending, a request whose tool list the edge would refuse.
 *
 * Logs the family breakdown — the one fact that says which catalogue grew —
 * and throws {@link ToolLimitExceededError}.
 */
export function assertToolCountWithinLimit(
  toolNames: readonly string[],
  context: { readonly surface?: string; readonly model?: string } = {},
): void {
  if (toolNames.length <= MAX_TOOLS_PER_INFERENCE_REQUEST) return;
  log.providers.error(
    {
      toolCount: toolNames.length,
      limit: MAX_TOOLS_PER_INFERENCE_REQUEST,
      families: toolFamilyCounts(toolNames),
      surface: context.surface,
      model: context.model,
    },
    'Inference request refused before sending: too many tools',
  );
  throw new ToolLimitExceededError({ toolCount: toolNames.length });
}
