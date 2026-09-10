import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the agent editor shows while it has no agent, and when it asks for one.
 *
 * ## The report
 *
 * Create a private draft, edit it, reload the tab: "Loading…" forever. The
 * network panel told the story — `GET /agents/<id>` answered 404 while
 * `GET /agents/me`, a moment later, listed the same id as an unpublished draft
 * (#530). The 404 was RIGHT: the request had left before the Oxy session had
 * its bearer, so the route saw a stranger asking for somebody's draft. What was
 * wrong was on this side, twice over: the query fired before the session could
 * sign it, and the screen rendered a failed query as one still loading.
 *
 * ## What is measured
 *
 * Three things, each against the API double answering the way the route does:
 *
 * 1. Not a single request while the session is still minting its token — and
 *    exactly one the moment it has. The recovery is the `enabled` flip; nothing
 *    else on the screen has to notice.
 * 2. A 404 is a not-found screen with a way back to the list, asked for ONCE.
 *    The route answered it deliberately, so three more tries with the same
 *    credential are three more seconds of the state the person is stuck in.
 * 3. Any other failure is an error screen with a Retry that runs the query
 *    again — and a Retry that then succeeds opens the editor.
 *
 * The screen's mocks are the ones `autosave-writes-once.test.tsx` renders it
 * under; the session double is the only thing that differs, because the session
 * is the subject here.
 */

const getRequest = vi.hoisted(() => vi.fn());
const replace = vi.hoisted(() => vi.fn());
/**
 * The session, as `useOxy()` reports it. Mutable so one test can start with the
 * token still pending and then hand it over, the way a reload does.
 */
const session = vi.hoisted(() => ({ isPrivateApiPending: false }));

vi.mock('@/lib/api/client', () => ({
  default: {
    get: getRequest,
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('@oxy.so/bloom/toast', () => ({
  toast: { loading: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('expo-crypto', () => ({ getRandomValues: (array: Uint8Array) => array }));
vi.mock('@oxy.so/bloom/surfaces', () => ({ confirm: vi.fn(async () => false) }));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'agent-1' }),
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace }),
}));

vi.mock('@oxy.so/services', () => ({
  useOxy: () => ({
    isAuthenticated: true,
    isPrivateApiPending: session.isPrivateApiPending,
    oxyServices: {
      updateAccount: vi.fn(async () => ({})),
      checkUsernameAvailability: async () => ({ available: true }),
    },
  }),
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return {
    Platform: { OS: 'web', select: (spec: Record<string, unknown>) => spec.web },
    View: host('View'),
    ScrollView: host('ScrollView'),
    Pressable: host('Pressable'),
    TextInput: host('TextInput'),
  };
});

vi.mock('@/components/ui/textarea', async () => {
  const ReactModule = await import('react');
  return { Textarea: (props: Record<string, unknown>) => ReactModule.createElement('Textarea', props) };
});
vi.mock('@/components/ui/input', async () => {
  const ReactModule = await import('react');
  return { Input: (props: Record<string, unknown>) => ReactModule.createElement('Input', props) };
});
vi.mock('@/components/ui/switch', async () => {
  const ReactModule = await import('react');
  return { Switch: (props: Record<string, unknown>) => ReactModule.createElement('Switch', props) };
});
vi.mock('@/components/ui/label', async () => {
  const ReactModule = await import('react');
  return {
    Label: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Label', props, children),
  };
});
vi.mock('@/components/ui/text', async () => {
  const ReactModule = await import('react');
  return {
    Text: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Text', props, children),
  };
});
vi.mock('@/components/ui/button', async () => {
  const ReactModule = await import('react');
  return {
    Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Button', props, children),
  };
});
vi.mock('@/components/ui/toggle-group', async () => {
  const ReactModule = await import('react');
  return {
    ToggleGroup: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('ToggleGroup', props, children),
    ToggleGroupItem: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('ToggleGroupItem', props, children),
  };
});
vi.mock('@/components/ui/panel', async () => {
  const ReactModule = await import('react');
  return {
    Panel: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Panel', props, children),
  };
});
vi.mock('@/components/ui/color-picker', async () => {
  const ReactModule = await import('react');
  return {
    ColorPicker: ({ renderSwatch: _renderSwatch, ...props }: Record<string, unknown>) =>
      ReactModule.createElement('ColorPicker', props),
  };
});
vi.mock('@/components/ui/dropdown-menu', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return {
    Root: host('MenuRoot'),
    Trigger: host('MenuTrigger'),
    Content: host('MenuContent'),
    Item: host('MenuItem'),
    ItemIcon: host('MenuItemIcon'),
    ItemTitle: host('MenuItemTitle'),
  };
});
vi.mock('@oxy.so/bloom/dialog', async () => {
  const ReactModule = await import('react');
  return {
    Dialog: ({ open, children }: React.PropsWithChildren<{ open?: boolean }>) =>
      open === true ? ReactModule.createElement('Dialog', null, children) : null,
  };
});
vi.mock('@oxy.so/bloom/search', async () => {
  const ReactModule = await import('react');
  return { Search: (props: Record<string, unknown>) => ReactModule.createElement('Search', props) };
});
vi.mock('@oxy.so/bloom/button', async () => {
  const ReactModule = await import('react');
  return {
    GhostButton: (props: Record<string, unknown>) => ReactModule.createElement('GhostButton', props),
  };
});
vi.mock('@oxy.so/bloom/item', async () => {
  const ReactModule = await import('react');
  return { Item: (props: Record<string, unknown>) => ReactModule.createElement('Item', props) };
});
vi.mock('@oxy.so/bloom/settings-list', async () => {
  const ReactModule = await import('react');
  return {
    SettingsListGroup: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('SettingsListGroup', props, children),
    SettingsListItem: (props: Record<string, unknown>) =>
      ReactModule.createElement('SettingsListItem', props),
  };
});
vi.mock('@oxy.so/bloom/content-panel', async () => {
  const ReactModule = await import('react');
  return {
    ContentPanel: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('ContentPanel', props, children),
  };
});
vi.mock('@alia.onl/sdk', async () => {
  const ReactModule = await import('react');
  return {
    IdentityMark: (props: Record<string, unknown>) => ReactModule.createElement('IdentityMark', props),
  };
});
vi.mock('lucide-react-native', async () => {
  const ReactModule = await import('react');
  const glyph = (props: Record<string, unknown>) => ReactModule.createElement('Glyph', props);
  const names = [
    'ArrowLeft', 'X', 'Plus', 'Ellipsis', 'Settings', 'ChevronRight', 'Search',
    'FileText', 'Globe', 'Terminal', 'FileDown', 'FolderOpen', 'Image', 'Brain',
    'Users', 'Send', 'Trash2',
  ];
  return Object.fromEntries(names.map((name) => [name, glyph]));
});
vi.mock('@/components/agent-capability-toggles', async () => {
  const ReactModule = await import('react');
  return {
    AgentCapabilityToggles: (props: Record<string, unknown>) =>
      ReactModule.createElement('AgentCapabilityToggles', props),
  };
});
vi.mock('@/components/agent-connector-grants', async () => {
  const ReactModule = await import('react');
  return {
    AgentConnectorGrants: (props: Record<string, unknown>) =>
      ReactModule.createElement('AgentConnectorGrants', props),
  };
});
vi.mock('@/lib/constants/agent-colors', () => ({ AGENT_SWATCHES: ['blue', 'violet'] }));
vi.mock('@/lib/agents/agent-color', () => ({ agentTint: () => 'rgb(0 0 0)' }));
vi.mock('@/lib/useColorScheme', () => ({
  useColorScheme: () => ({ colors: { mutedForeground: 'rgb(113 113 122)' } }),
}));
vi.mock('@/lib/hooks/use-is-large-screen', () => ({ useIsLargeScreen: () => true }));
vi.mock('@/lib/hooks/use-agent-bots', () => ({
  useAgentBots: () => ({ bots: [], registerBot: vi.fn(), removeBot: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-translation', () => {
  const t = (key: string) => key;
  const changeLocale = () => undefined;
  return { useTranslation: () => ({ t, locale: 'en', changeLocale }) };
});
vi.mock('@/lib/stores/library-store', () => {
  const state = { files: [] as unknown[], loadFiles: () => undefined };
  return { useLibraryStore: (select: (s: typeof state) => unknown) => select(state) };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * A host element by its mocked name. Compared through a `string`, because
 * `node.type` is `ElementType` and a literal beside it is a type error.
 */
function isHost(node: ReactTestInstance, name: string): boolean {
  return node.type === name;
}

const { default: EditAgentScreen } = await import('../[id]');
const { useAgent } = await import('@/lib/hooks/use-agents');

const AGENT_URL = '/agents/agent-1';

/** The agent as `GET /agents/:id` serves it to its owner. */
function agentFixture(): Record<string, unknown> {
  return {
    _id: 'agent-1',
    oxyAccountId: 'acct-bot',
    name: 'Pepe',
    handle: 'pepe',
    color: 'blue',
    tagline: 'finds things out',
    description: 'a description',
    author: 'oxy-caller',
    authorName: 'Nate',
    category: 'Research',
    tags: ['research'],
    rating: 0,
    reviewCount: 0,
    usageCount: 0,
    hireCount: 0,
    price: null,
    capabilityGrants: ['web'],
    skills: [],
    knowledge: [],
    isFeatured: false,
    isTrending: false,
    isPublished: false,
    status: 'active',
    access: 'private',
    systemPrompt: 'you are helpful',
    allowedModels: ['route:auto'],
    archetype: 'general',
    archetypeConfig: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

/** An Axios-shaped refusal, exactly as the client rejects with it. */
function httpError(status: number, error: string): Error {
  return Object.assign(new Error('Request failed'), { response: { status, data: { error } } });
}

/** How many times the screen asked the route for the agent. */
function agentRequests(): number {
  return getRequest.mock.calls.filter((call) => call[0] === AGENT_URL).length;
}

let renderer: ReactTestRenderer | null = null;

/**
 * The screen under a query client with the LIBRARY defaults — no `retry: false`
 * — because how many times the query retries is one of the things measured.
 */
function screenElement(client: QueryClient): React.ReactElement {
  return React.createElement(QueryClientProvider, { client }, React.createElement(EditAgentScreen));
}

async function renderScreen(): Promise<{ renderer: ReactTestRenderer; client: QueryClient }> {
  const client = new QueryClient();
  let next!: ReactTestRenderer;
  await act(async () => {
    next = create(screenElement(client));
  });
  renderer = next;
  return { renderer: next, client };
}

/** Virtual time, one second per `act`, so retries scheduled by a re-render get to run. */
async function letTimePass(seconds: number): Promise<void> {
  for (let second = 0; second < seconds; second += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
  }
}

function texts(root: ReactTestInstance): string[] {
  return root
    .findAll((node) => isHost(node, 'Text') && typeof node.props.children === 'string')
    .map((node) => node.props.children as string);
}

function buttonLabelled(root: ReactTestInstance, label: string): ReactTestInstance {
  const found = root.findAll(
    (node) => isHost(node, 'Button') && node.props.accessibilityLabel === label,
  );
  if (found.length !== 1) throw new Error(`expected one "${label}" button, found ${found.length}`);
  return found[0];
}

function editorIsOpen(root: ReactTestInstance): boolean {
  return root.findAll((node) => isHost(node, 'Textarea')).length > 0;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.clearAllMocks();
  session.isPrivateApiPending = false;
  getRequest.mockImplementation(async (url: string) => {
    if (url === AGENT_URL) return { data: { agent: agentFixture() } };
    if (url === '/skills') return { data: { skills: [] } };
    return { data: { connectors: [] } };
  });
});

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
  vi.useRealTimers();
});

describe('before the session can sign the request', () => {
  it('asks for nothing, shows Loading, and fetches exactly once when the token lands', async () => {
    session.isPrivateApiPending = true;
    const { renderer: screen, client } = await renderScreen();
    await letTimePass(2);

    expect(agentRequests(), 'a request before the bearer exists is the 404 itself').toBe(0);
    expect(texts(screen.root)).toContain('common.loading');
    expect(editorIsOpen(screen.root)).toBe(false);

    // The session hands over its token. Nothing else changes.
    session.isPrivateApiPending = false;
    await act(async () => {
      screen.update(screenElement(client));
    });
    await letTimePass(2);

    expect(agentRequests()).toBe(1);
    expect(editorIsOpen(screen.root), 'the editor opens on its own once the query can run').toBe(true);
  });

  /**
   * The hook on its own, so the property is pinned where it lives and not
   * only through the one screen that happened to report it.
   */
  it('useAgent stays idle until the private API is usable', async () => {
    session.isPrivateApiPending = true;
    const seen: string[] = [];
    function Probe() {
      const query = useAgent('agent-1');
      seen.push(query.fetchStatus);
      return null;
    }
    const client = new QueryClient();
    // A fresh element per render: React skips a re-render handed the very same
    // element object, and the probe has to re-read the session to see it change.
    const element = () =>
      React.createElement(QueryClientProvider, { client }, React.createElement(Probe));
    let probe!: ReactTestRenderer;
    await act(async () => {
      probe = create(element());
    });
    renderer = probe;
    await letTimePass(1);
    expect(new Set(seen), 'never fetching while pending').toEqual(new Set(['idle']));
    expect(agentRequests()).toBe(0);

    session.isPrivateApiPending = false;
    await act(async () => {
      probe.update(element());
    });
    await letTimePass(1);
    expect(seen).toContain('fetching');
    expect(agentRequests()).toBe(1);
  });
});

describe('when the route says the agent is not there', () => {
  it('shows not-found with a way back to the list, and does not retry', async () => {
    getRequest.mockImplementation(async (url: string) => {
      if (url === AGENT_URL) throw httpError(404, 'Agent not found');
      return { data: { skills: [], connectors: [] } };
    });
    const { renderer: screen } = await renderScreen();
    // Long enough for every default retry to have fired, had there been any.
    await letTimePass(10);

    const shown = texts(screen.root);
    expect(shown).toContain('agents.notFound');
    expect(shown).toContain('agents.notFoundDetail');
    expect(shown, 'a failed query is not a loading one').not.toContain('common.loading');
    expect(agentRequests(), 'a deliberate 404 is asked once').toBe(1);

    await act(async () => {
      (buttonLabelled(screen.root, 'agents.backToAgents').props.onPress as () => void)();
    });
    expect(replace).toHaveBeenCalledWith('/(app)/agents');
    expect(screen.root.findAll((node) => isHost(node, 'Button') && node.props.accessibilityLabel === 'agents.retry')).toHaveLength(0);
  });
});

describe('when the route fails for any other reason', () => {
  it('shows the error with a Retry that runs the query again and opens the editor on success', async () => {
    let failing = true;
    getRequest.mockImplementation(async (url: string) => {
      if (url === AGENT_URL) {
        if (failing) throw httpError(503, 'Agent infrastructure unavailable');
        return { data: { agent: agentFixture() } };
      }
      return { data: { skills: [], connectors: [] } };
    });
    const { renderer: screen } = await renderScreen();
    // The library's own retries — 1s, 2s and 4s apart — all fail first.
    await letTimePass(10);

    const shown = texts(screen.root);
    expect(shown).toContain('agents.loadFailed');
    expect(shown, 'the route message reaches the screen').toContain('Agent infrastructure unavailable');
    expect(shown).not.toContain('common.loading');
    expect(agentRequests(), 'a transient failure IS retried').toBeGreaterThan(1);
    const askedBeforeRetry = agentRequests();

    failing = false;
    await act(async () => {
      (buttonLabelled(screen.root, 'agents.retry').props.onPress as () => void)();
    });
    await letTimePass(2);

    expect(agentRequests()).toBe(askedBeforeRetry + 1);
    expect(editorIsOpen(screen.root)).toBe(true);
  });
});
