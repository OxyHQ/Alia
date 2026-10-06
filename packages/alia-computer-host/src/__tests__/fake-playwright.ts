/**
 * Just enough of Playwright's Browser / BrowserContext / Page for the pool
 * suite: no Chromium, but every call the pool makes is recorded, and a test
 * can say where a navigation "lands" (a redirect) or make it fail.
 */
import type { Browser } from 'playwright-core';

type Handler = (...args: unknown[]) => void;

class Emitter {
  private readonly handlers = new Map<string, Handler[]>();
  on(event: string, handler: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

export class FakePage extends Emitter {
  currentUrl = 'about:blank';
  closed = false;
  readonly gotos: string[] = [];
  readonly actions: string[] = [];
  /** Where a goto to a URL ends up (a redirect), by URL. */
  redirects = new Map<string, string>();
  failNavigation = false;

  constructor(private readonly context: FakeContext) {
    super();
  }

  url() {
    return this.currentUrl;
  }
  async title() {
    return `Title of ${this.currentUrl}`;
  }
  async goto(url: string) {
    this.gotos.push(url);
    if (this.failNavigation) throw new Error('net::ERR_CONNECTION_REFUSED');
    this.currentUrl = this.redirects.get(url) ?? url;
    return null;
  }
  async screenshot() {
    return Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  }
  async evaluate(script: unknown) {
    this.actions.push(`evaluate:${typeof script}`);
    return { url: this.currentUrl, title: 't', text: 'page text', truncated: false, elements: [] };
  }
  readonly mouse = {
    click: async (x: number, y: number) => {
      this.actions.push(`click:${x},${y}`);
    },
    wheel: async (dx: number, dy: number) => {
      this.actions.push(`wheel:${dx},${dy}`);
    },
  };
  readonly keyboard = {
    insertText: async (text: string) => {
      this.actions.push(`text:${text}`);
    },
    press: async (key: string) => {
      this.actions.push(`key:${key}`);
    },
  };
  isClosed() {
    return this.closed;
  }
  async close() {
    this.closed = true;
    this.context.removePage(this);
  }
  setDefaultTimeout() {}
  async waitForLoadState() {}
}

export class FakeContext extends Emitter {
  readonly pageList: FakePage[] = [];
  closed = false;
  state: { cookies: { name: string; value: string }[]; origins: unknown[] } = { cookies: [], origins: [] };
  storageStateCalls = 0;

  constructor(readonly options: Record<string, unknown>) {
    super();
  }

  pages() {
    return [...this.pageList];
  }
  async newPage() {
    const page = new FakePage(this);
    this.pageList.push(page);
    this.emit('page', page);
    return page;
  }
  /** A site opening a popup. */
  popup() {
    const page = new FakePage(this);
    this.pageList.push(page);
    this.emit('page', page);
    return page;
  }
  removePage(page: FakePage) {
    const at = this.pageList.indexOf(page);
    if (at !== -1) this.pageList.splice(at, 1);
  }
  async storageState() {
    this.storageStateCalls += 1;
    if (this.closed) throw new Error('context closed');
    return this.state;
  }
  async close() {
    this.closed = true;
  }
}

export class FakeBrowser extends Emitter {
  readonly contexts: FakeContext[] = [];
  connected = true;
  closed = false;

  version() {
    return '140.0.7339.16';
  }
  isConnected() {
    return this.connected;
  }
  async newContext(options: Record<string, unknown>) {
    const context = new FakeContext(options);
    this.contexts.push(context);
    return context;
  }
  async close() {
    this.closed = true;
    this.connected = false;
  }
  crash() {
    this.connected = false;
    this.emit('disconnected');
  }
  asBrowser(): Browser {
    return this as unknown as Browser;
  }
}
