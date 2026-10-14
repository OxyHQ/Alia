import { resolveFaviconUrl } from '@clarity.surf/sdk';
import type { ToolInvocation } from '@/shared/contracts/messages';
import {
  isWebInvocation,
  type LiveResearch,
  type TaskListLog,
  taskListLog as sdkTaskListLog,
  type WebSearchLog,
  webSearchLog as sdkWebSearchLog,
} from '@alia.onl/sdk';
import type { Translate } from '@alia.onl/sdk/tools';

/**
 * A turn's tool calls, as the two Bloom logs draw them — the SDK's work log with the app's
 * two inputs wired in: its translator, and Clarity's copy of each site's icon.
 *
 * The mapping itself (what is a web step, what a task, when a unit counts as revealed) lives
 * in `@alia.onl/sdk` so the SDK's chat and this app draw a turn the same way.
 */

export { isWebInvocation, type LiveResearch, type TaskListLog, type WebSearchLog };

export function webSearchLog(
  invocations: readonly ToolInvocation[] | undefined,
  research: LiveResearch | undefined,
  t: Translate,
): WebSearchLog {
  return sdkWebSearchLog(invocations, research, { t, faviconUrl: resolveFaviconUrl });
}

export function taskListLog(
  invocations: readonly ToolInvocation[] | undefined,
  live: boolean,
  t: Translate,
): TaskListLog {
  return sdkTaskListLog(invocations, live, { t });
}
