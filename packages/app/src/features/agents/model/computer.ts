/**
 * The agent's computer as the app receives it from `GET /agents/:id/computer`
 * and its siblings (`packages/api/src/routes/agents/computer.ts`). Always the
 * caller's OWN computer with that agent: the API composes it from the signed-in
 * person, so nothing here names a person.
 */

export const BROWSER_VIEWPORT = { width: 1280, height: 800 } as const;

export type BrowserController = 'agent' | 'owner';

export interface ComputerStatus {
  state: 'running' | 'stopped' | 'asleep';
  workspace: string;
  usageBytes: number | null;
  quotaBytes: number;
  idleStopMinutes: number;
}

export interface BrowserStatus {
  state: 'open' | 'closed' | 'asleep';
  url: string;
  title: string;
  controller: BrowserController;
  pendingDownloads: number;
  lastActiveAt: string | null;
}

export interface AgentComputer {
  /** Whether the agent holds the `computer` grant (it may have used it before). */
  granted: boolean;
  computer: ComputerStatus;
  browser: BrowserStatus;
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
}

export interface WorkspaceListing {
  path: string;
  entries: WorkspaceEntry[];
  truncated: boolean;
}

export interface CommandReceiptSummary {
  operationId: string;
  command: string;
  cwd: string;
  background: boolean;
  status: 'running' | 'started' | 'succeeded' | 'failed' | 'timed_out' | 'interrupted';
  exitCode: number | null;
  startedAt: string;
  completedAt: string | null;
}

export interface BrowserActionReceipt {
  action: 'open' | 'navigate' | 'input' | 'control' | 'close' | 'download';
  by: BrowserController;
  origin: string;
  detail: string;
  status: 'ok' | 'refused' | 'failed';
  at: string;
}

export interface ComputerReceipts {
  commands: CommandReceiptSummary[];
  browser: BrowserActionReceipt[];
}

export interface BrowserScreenshot {
  mimeType: string;
  width: number;
  height: number;
  data: string;
}

/** The keys the live view offers — a subset of what the host accepts. */
export const LIVE_VIEW_KEYS = ['Enter', 'Tab', 'Backspace', 'Escape'] as const;
export type LiveViewKey = (typeof LIVE_VIEW_KEYS)[number];

export type BrowserInput =
  | { type: 'click'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: LiveViewKey }
  | { type: 'scroll'; deltaY: number };

/**
 * A press on the screenshot, as drawn at `drawn` size, in the browser's own
 * 1280×800 coordinates — clamped, so an edge press is still on the page.
 * `null` before the image has a size.
 */
export function viewportPoint(
  press: { x: number; y: number },
  drawn: { width: number; height: number },
): { x: number; y: number } | null {
  if (drawn.width <= 0 || drawn.height <= 0) return null;
  const clamp = (value: number, max: number) => Math.min(max - 1, Math.max(0, Math.floor(value)));
  return {
    x: clamp((press.x * BROWSER_VIEWPORT.width) / drawn.width, BROWSER_VIEWPORT.width),
    y: clamp((press.y * BROWSER_VIEWPORT.height) / drawn.height, BROWSER_VIEWPORT.height),
  };
}

/** The parent of a workspace path, or `null` at `/workspace` itself. */
export function parentPath(path: string): string | null {
  const trimmed = path.replace(/\/+$/, '');
  if (trimmed === '/workspace' || !trimmed.startsWith('/workspace/')) return null;
  return trimmed.slice(0, trimmed.lastIndexOf('/')) || '/workspace';
}

/** `12.3 KB`, for a file row. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
