import { beforeEach, expect, it, vi } from 'vitest';

const world = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  instances: [] as {
    init: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    execute: ReturnType<typeof vi.fn>;
  }[],
  transports: [] as { dispose: ReturnType<typeof vi.fn>; fetch: typeof fetch }[],
  init: () => Promise.resolve(),
  close: () => Promise.resolve(),
  execute: () => Promise.resolve({ message: 'done' }),
}));
vi.mock('electron', () => ({ clipboard: {}, shell: {}, desktopCapturer: {} }));
vi.mock('electron-store', () => ({
  default: class {
    get() {
      return 'https://api.alia.onl';
    }
  },
}));
vi.mock('../stagehand-transport', () => ({ stagehandClientForTransport: () => ({}) }));
vi.mock('../catalogue', () => ({ resolveRequiredModelId: async () => 'publisher/model' }));
vi.mock('../auth', () => ({
  linkedAliaClient: () => {
    const t = { dispose: vi.fn(), fetch: globalThis.fetch };
    world.transports.push(t);
    return t;
  },
  onSessionContextChange: (listener: () => void) => {
    world.listeners.add(listener);
    return () => world.listeners.delete(listener);
  },
}));
vi.mock('@browserbasehq/stagehand', () => ({
  Stagehand: class {
    init = vi.fn(() => world.init());
    close = vi.fn(() => world.close());
    execute = vi.fn(() => world.execute());
    context = { pages: () => [{ screenshot: async () => Buffer.from('image') }] };
    agent() {
      return { execute: this.execute };
    }
    constructor() {
      world.instances.push(this);
    }
  },
}));
import { ToolExecutor } from '../tools';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeEach(() => {
  world.listeners.clear();
  world.instances.length = 0;
  world.transports.length = 0;
  world.init = () => Promise.resolve();
  world.close = () => Promise.resolve();
  world.execute = () => Promise.resolve({ message: 'done' });
});
it('reset during initialization closes the late browser without installing it', async () => {
  const pending = deferred<void>();
  world.init = () => pending.promise;
  const tools = new ToolExecutor();
  const action = tools.browserAction({ action: 'read' });
  await vi.waitFor(() => expect(world.instances).toHaveLength(1));
  await tools.reset();
  pending.resolve();
  await expect(action).rejects.toThrow('context changed');
  expect(world.instances[0].close).toHaveBeenCalledOnce();
  expect(world.instances[0].execute).not.toHaveBeenCalled();
  expect(world.transports[0].dispose).toHaveBeenCalled();
  expect(world.listeners.size).toBe(0);
});
it('account changes refuse a late browser result', async () => {
  const pending = deferred<{ message: string }>();
  world.execute = () => pending.promise;
  const tools = new ToolExecutor();
  const action = tools.browserAction({ action: 'read' });
  await vi.waitFor(() => expect(world.instances[0]?.execute).toHaveBeenCalledOnce());
  for (const listener of world.listeners) listener();
  pending.resolve({ message: 'previous account data' });
  await expect(action).rejects.toThrow('context changed');
  expect(world.instances[0].close).toHaveBeenCalledOnce();
});
it('an older asynchronous close cannot clear the replacement browser', async () => {
  const tools = new ToolExecutor();
  await tools.browserAction({ action: 'first' });
  const closing = deferred<void>();
  world.close = () => closing.promise;
  const oldClose = tools.closeBrowser();
  await tools.browserAction({ action: 'second' });
  closing.resolve();
  await oldClose;
  await tools.browserAction({ action: 'third' });
  expect(world.instances).toHaveLength(2);
  expect(world.instances[1].execute).toHaveBeenCalledTimes(2);
  await tools.reset();
});
