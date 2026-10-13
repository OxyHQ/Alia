import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  webSearchLog: vi.fn(() => ({ steps: [], revealed: 0 })),
  taskListLog: vi.fn(() => ({ tasks: [], revealed: 0 })),
}));

vi.mock('@alia.onl/sdk', () => ({
  isWebInvocation: () => false,
  webSearchLog: sdk.webSearchLog,
  taskListLog: sdk.taskListLog,
}));
vi.mock('@clarity.surf/sdk', () => ({ resolveFaviconUrl: (url: string) => `clarity:${url}` }));

import { taskListLog, webSearchLog } from '../work-log';

/**
 * What a turn's calls MEAN as `WebSearch` steps and `TaskList` tasks is the SDK's, and is
 * tested there (`packages/alia-chat/tests/lib/work-log.test.ts`). What is the app's is the
 * two inputs it hands that mapping: its translator, and Clarity's copy of each site's icon.
 */
const t = (key: string) => key;

describe('the app work log', () => {
  beforeEach(() => {
    sdk.webSearchLog.mockClear();
    sdk.taskListLog.mockClear();
  });

  it("gives the web trail the app's translator and Clarity's icons", () => {
    const research = { currentQuery: 'rates' };
    webSearchLog([], research, t);

    expect(sdk.webSearchLog).toHaveBeenCalledOnce();
    const [invocations, passedResearch, options] = sdk.webSearchLog.mock.calls[0] as unknown as [
      unknown[],
      unknown,
      { t: unknown; faviconUrl: (url: string) => string },
    ];
    expect(invocations).toEqual([]);
    expect(passedResearch).toBe(research);
    expect(options.t).toBe(t);
    expect(options.faviconUrl('https://a.test')).toBe('clarity:https://a.test');
  });

  it('gives the task list the same translator and the turn’s liveness', () => {
    taskListLog([], true, t);

    const [, live, options] = sdk.taskListLog.mock.calls[0] as unknown as [
      unknown[],
      boolean,
      { t: unknown },
    ];
    expect(live).toBe(true);
    expect(options.t).toBe(t);
  });
});
