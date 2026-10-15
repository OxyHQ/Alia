import type { ToolInvocation } from '../runtime/types';

/**
 * Where a tool call stands:
 *  - `running`: still in flight in a live turn.
 *  - `done`: it returned a result without an error.
 *  - `error`: it returned, and the result carries an `error`.
 *  - `interrupted`: it never returned and its turn is over — a stop, a failure, or a
 *    persisted turn cut short. It must not read as running.
 */
export type ToolCallStatus = 'running' | 'done' | 'error' | 'interrupted';

export function toolCallStatus(
  inv: Pick<ToolInvocation, 'state' | 'result'>,
  live: boolean,
): ToolCallStatus {
  if (inv.state !== 'result') return live ? 'running' : 'interrupted';
  const result: unknown = inv.result;
  if (
    result !== null &&
    typeof result === 'object' &&
    'error' in result &&
    Boolean((result as { error?: unknown }).error)
  ) {
    return 'error';
  }
  return 'done';
}
