import type { ToolInvocation } from '../runtime/types';

/** A canvas artifact as `CanvasComponent` draws it. */
export interface CanvasResult {
  type: string;
  title: string;
  data: unknown;
}

/**
 * A finished canvas call's artifact; `null` for any other call, one still running, or one the tool
 * refused (`{ error }`). An artifact without a title is titled by its type.
 */
export function canvasResultOf(call: ToolInvocation): CanvasResult | null {
  if (call.toolName !== 'canvas' || call.state !== 'result') return null;
  const result: unknown = call.result;
  if (result === null || typeof result !== 'object') return null;
  const { type, title, data } = result as Record<string, unknown>;
  if (typeof type !== 'string' || type === '' || data === undefined || data === null) return null;
  return { type, title: typeof title === 'string' && title !== '' ? title : type, data };
}
