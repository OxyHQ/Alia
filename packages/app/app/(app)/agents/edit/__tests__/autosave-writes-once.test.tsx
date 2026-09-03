import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * How many times the agent editor WRITES, and how many toasts one write raises.
 *
 * ## The report
 *
 * *"el bug de saving… sigue, ahora no para de mostrar toasts que pone saving"* —
 * the third time this screen's autosave has been reported. The first was that
 * it saved nothing (a `.strict()` schema refusing `permissions`, 400 per
 * keystroke, swallowed twice). The second was a write loop through `t`'s
 * identity. This is the third, and the toast is a SYMPTOM: a toast per save is
 * correct, so a toast that never stops means a save that never stops.
 *
 * ## What this file measures, and why it is requests and not toasts
 *
 * Two different faults produce the same picture on screen — a save loop each
 * raising its own toast, and a single save raising a toast per render — and
 * only counting the PATCHes tells them apart. So `apiClient.patch` is the
 * subject of the first test and `toast` of the second, never the other way
 * round.
 *
 * Measured on `main` before the fix, with the mutation's own answer fed back
 * exactly as the API sends it: **one keystroke produced a PATCH every second
 * for as long as the screen stayed mounted** — 11 of them in the 11 seconds
 * this test covers, and the second one already carried `skills: []`, so the
 * loop was also deleting the agent's linked skills and knowledge on its way
 * round. After the fix: 1.
 *
 * ## The response is the subject, not the outgoing body
 *
 * Two earlier PRs "verified" this editor by reading the payload it sent while
 * every save was answered 400. So the doubles here answer the way the route
 * answers — including the refusal case — and the assertions are about what the
 * screen does with the ANSWER.
 */

const patchRequest = vi.hoisted(() => vi.fn());
const getRequest = vi.hoisted(() => vi.fn());
const toastCalls = vi.hoisted(() => ({
  loading: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
}));
const updateAccount = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock('@/lib/api/client', () => ({
  default: {
    get: getRequest,
    post: vi.fn(),
    patch: patchRequest,
    delete: vi.fn(),
  },
}));

vi.mock('@oxyhq/bloom/toast', () => ({ toast: toastCalls }));
// `cn` (via `lib/utils.ts`) reaches `expo-crypto` through `random-uuid`, whose
// native module does not exist under this runner.
vi.mock('expo-crypto', () => ({ getRandomValues: (array: Uint8Array) => array }));
vi.mock('@oxyhq/bloom/surfaces', () => ({ confirm: vi.fn(async () => false) }));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'agent-1' }),
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
}));

vi.mock('@oxyhq/services', () => ({
  useOxy: () => ({
    isAuthenticated: true,
    oxyServices: {
      updateAccount,
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

/**
 * The leaf components, as host elements carrying their props.
 *
 * Every one of them is a real React Native tree this runner cannot parse, and
 * none of them is under test: what is under test is how many times the screen
 * calls the network when one of their `onChange` props fires. Keeping the props
 * on a host element is what lets the test fire them.
 */
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
vi.mock('@oxyhq/bloom/dialog', async () => {
  const ReactModule = await import('react');
  return {
    Dialog: ({ open, children }: React.PropsWithChildren<{ open?: boolean }>) =>
      open === true ? ReactModule.createElement('Dialog', null, children) : null,
  };
});
vi.mock('@oxyhq/bloom/search', async () => {
  const ReactModule = await import('react');
  return { Search: (props: Record<string, unknown>) => ReactModule.createElement('Search', props) };
});
vi.mock('@oxyhq/bloom/button', async () => {
  const ReactModule = await import('react');
  return {
    GhostButton: (props: Record<string, unknown>) => ReactModule.createElement('GhostButton', props),
  };
});
vi.mock('@oxyhq/bloom/item', async () => {
  const ReactModule = await import('react');
  return { Item: (props: Record<string, unknown>) => ReactModule.createElement('Item', props) };
});
vi.mock('@oxyhq/bloom/settings-list', async () => {
  const ReactModule = await import('react');
  return {
    SettingsListGroup: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('SettingsListGroup', props, children),
    SettingsListItem: (props: Record<string, unknown>) =>
      ReactModule.createElement('SettingsListItem', props),
  };
});
vi.mock('@oxyhq/bloom/content-panel', async () => {
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
/**
 * `t` is ONE function, exactly as the real hook memoises it.
 *
 * A factory returning a fresh arrow per call would reintroduce the write loop
 * this screen was already fixed for once — the effect chain re-runs on a new
 * `t` identity — and the test would then be measuring its own double.
 */
vi.mock('@/lib/hooks/use-translation', () => {
  const t = (key: string) => key;
  const changeLocale = () => undefined;
  return { useTranslation: () => ({ t, locale: 'en', changeLocale }) };
});
vi.mock('@/lib/stores/library-store', () => {
  // One state object, so a selector reading `files` gets the same array every
  // render — a fresh `[]` per call is a dependency that changes on every render.
  const state = { files: [] as unknown[], loadFiles: () => undefined };
  return { useLibraryStore: (select: (s: typeof state) => unknown) => select(state) };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { default: EditAgentScreen } = await import('../[id]');

/**
 * The id the screen reuses, read off its own first pending toast.
 *
 * Not imported from the screen: a route module's named exports are expo-router's
 * business, and hard-coding the string here would let the two drift apart
 * silently. What matters is that ONE id is used and reused, which is what makes
 * the toast an indicator instead of a log.
 */
function toastId(): string {
  const options = toastCalls.loading.mock.calls[0]?.[1] as { id?: string } | undefined;
  if (options?.id === undefined) throw new Error('the pending toast carries no id, so it cannot be replaced');
  return options.id;
}

/** One skill and one knowledge file, so a save that drops them is visible. */
const SKILLS = [{ _id: 'skill-1', skillId: 'research', title: 'Research', icon: '🔎', color: 'blue' }];
const KNOWLEDGE = [
  { _id: 'file-1', name: 'handbook.pdf', type: 'pdf', category: 'docs', url: 'https://x/handbook.pdf' },
];

/** The agent as `GET /agents/:id` serves it — child lists ATTACHED. */
function agentFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    skills: SKILLS,
    knowledge: KNOWLEDGE,
    isFeatured: false,
    isTrending: false,
    isPublished: false,
    status: 'active',
    access: 'private',
    systemPrompt: 'you are helpful',
    allowedModels: ['kaana-v1'],
    archetype: 'general',
    archetypeConfig: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * The mutation's answer, with a FRESH `updatedAt` on every call.
 *
 * `agents.updated_at` carries drizzle's `$onUpdate`, so a real PATCH answers
 * with a row that differs from the cached one — which is exactly what makes the
 * response a new object in the query cache and re-runs anything keyed on it. A
 * fixture that echoed the same timestamp would let structural sharing hold the
 * old identity and no loop would be reproducible here at all.
 */
let patchCount = 0;
function patchAnswer(omitChildLists: boolean): { data: { agent: Record<string, unknown> } } {
  patchCount += 1;
  const agent = agentFixture({ updatedAt: new Date(Date.UTC(2026, 7, 1, 0, 0, patchCount)).toISOString() });
  if (omitChildLists) {
    delete agent.skills;
    delete agent.knowledge;
  }
  return { data: { agent } };
}

async function renderEditor(): Promise<{ renderer: ReactTestRenderer; client: QueryClient }> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(EditAgentScreen),
      ),
    );
  });
  // Let the agent query land AND let the screen finish opening: a microtask
  // flush alone leaves the tree in its loading state, and every assertion below
  // would then be made against a screen with no fields on it.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_200);
  });
  if (patchRequest.mock.calls.length > 0) {
    throw new Error('the editor wrote before anybody typed');
  }
  return { renderer, client };
}

/**
 * Virtual time passing the way real time does: ONE `act` per second.
 *
 * A single `advanceTimersByTimeAsync(12_000)` inside one `act` understates a
 * write loop badly — React flushes the updates it queues when the `act` boundary
 * closes, so a cycle that needs a re-render to schedule its next write only gets
 * round once. Measured on `main`: 12 seconds in one call reported 1 PATCH, the
 * same 12 seconds a second at a time reported 6. The loop was always there; the
 * bulk advance could not see it.
 */
async function letTimePass(seconds: number): Promise<void> {
  for (let second = 0; second < seconds; second += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
  }
}

/** The system-prompt box: the one editable field on the screen's main column. */
function systemPromptBox(renderer: ReactTestRenderer): { onChangeText: (text: string) => void } {
  const boxes = renderer.root.findAllByType('Textarea' as unknown as React.ComponentType);
  const box = boxes.find((node) => node.props.variant === 'ghost');
  if (box === undefined) throw new Error('the system prompt box is not on the screen');
  return box.props as { onChangeText: (text: string) => void };
}

/** What the screen sent, as the route would have received it. */
function patchBodies(): Array<Record<string, unknown>> {
  return patchRequest.mock.calls.map((call) => call[1] as Record<string, unknown>);
}

beforeEach(() => {
  /**
   * Only the two the debounce uses. Faking the whole clock also fakes what
   * React's scheduler and TanStack lean on, and the screen's render work then
   * advances with the virtual clock instead of independently of it.
   */
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.clearAllMocks();
  patchCount = 0;
  getRequest.mockImplementation(async (url: string) => {
    if (url === '/agents/agent-1') return { data: { agent: agentFixture() } };
    if (url === '/skills') return { data: { skills: [] } };
    return { data: { connectors: [] } };
  });
  patchRequest.mockImplementation(async () => patchAnswer(false));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a burst of typing is one write', () => {
  it('sends exactly one PATCH for five keystrokes, and none afterwards', async () => {
    const { renderer } = await renderEditor();

    // Five keystrokes inside the debounce window, the way somebody types.
    for (const text of ['y', 'yo', 'you', 'you ', 'you a']) {
      await act(async () => {
        systemPromptBox(renderer).onChangeText(text);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120);
      });
    }

    await letTimePass(2);
    expect(patchRequest, 'a burst of typing is one save, not one per keystroke').toHaveBeenCalledTimes(1);

    // And the screen goes quiet. This is the assertion the loop fails: nothing
    // was typed in these eleven seconds, so nothing may be written in them.
    await letTimePass(11);
    expect(
      patchRequest,
      `the editor kept writing with nobody typing: ${patchBodies().length} PATCHes`,
    ).toHaveBeenCalledTimes(1);

    expect(patchBodies()[0].systemPrompt).toBe('you a');
    await act(async () => {
      renderer.unmount();
    });
  });

  /**
   * The same session against the answer the route ACTUALLY sends today.
   *
   * `PATCH /agents/:id` returns `attachAgentIdentity(agent)` without
   * `withChildLists`, so its `agent` has no `skills` and no `knowledge` — a
   * different shape from the `GET` the screen loaded. Writing that into the
   * detail cache is what re-seeded the form with empty lists, and the next
   * autosave then sent `skills: []`, which DELETES them.
   *
   * Both halves are fixed — the route answers with the lists now, and the form
   * no longer re-seeds from the server while it is being edited — and this
   * pins the second one on its own: even handed a stripped answer, the editor
   * neither loops nor forgets what it is holding.
   */
  it('does not loop, or drop the linked lists, when the answer omits them', async () => {
    patchRequest.mockImplementation(async () => patchAnswer(true));
    const { renderer } = await renderEditor();

    await act(async () => {
      systemPromptBox(renderer).onChangeText('you are helpful and brief');
    });
    await letTimePass(12);

    expect(
      patchRequest,
      `one keystroke wrote ${patchBodies().length} times: ${JSON.stringify(patchBodies().map((b) => b.skills))}`,
    ).toHaveBeenCalledTimes(1);
    expect(patchBodies()[0].skills, 'the save dropped the agent linked skills').toEqual(['skill-1']);
    expect(patchBodies()[0].knowledge).toEqual(['file-1']);

    await act(async () => {
      renderer.unmount();
    });
  });

  /**
   * THE CONTROL, and the root cause stated as a property: **the server's copy
   * changing is not an edit, so it may not produce a write.**
   *
   * The loop closed through the query cache. `useUpdateAgent` writes its answer
   * into `agents.detail`, the screen's seeding effect listed that data in its
   * dependencies, and re-seeding assigned fresh array and object references
   * (`agent.skills || []`) to the very state the autosave effect watched — so
   * every write produced the next one, once a second, forever.
   *
   * This drives that cycle from OUTSIDE, which is what makes it a control
   * rather than a simulation: the cache is updated with a newer record exactly
   * as the mutation, a background refetch or another device would, and nothing
   * is typed. On `main` this is red — the re-seed fires the save. The screen has
   * to hold its draft.
   */
  it('control: a newer record arriving in the cache produces no write at all', async () => {
    const { renderer, client } = await renderEditor();

    await act(async () => {
      client.setQueryData(['agents', 'detail', 'agent-1'], {
        ...agentFixture({ tagline: 'edited somewhere else', updatedAt: '2026-08-02T00:00:00.000Z' }),
      });
    });
    await letTimePass(12);

    expect(
      patchRequest,
      `the screen answered a server-side change with ${patchBodies().length} write(s) of its own`,
    ).not.toHaveBeenCalled();
    expect(updateAccount, 'and the same for the identity half, which writes to Oxy').not.toHaveBeenCalled();

    // Not vacuous: the same screen, in the same state, still saves when it is
    // actually edited. Without this the assertions above would also pass on a
    // screen whose save is simply broken.
    await act(async () => {
      systemPromptBox(renderer).onChangeText('a real edit');
    });
    await letTimePass(2);
    expect(patchRequest).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.unmount();
    });
  });
});

describe('one save is one toast', () => {
  it('raises a single pending toast and a single result, both under one id', async () => {
    const { renderer } = await renderEditor();

    await act(async () => {
      systemPromptBox(renderer).onChangeText('you are helpful, and brief');
    });
    await letTimePass(12);

    expect(toastCalls.loading).toHaveBeenCalledTimes(1);
    expect(toastCalls.success).toHaveBeenCalledTimes(1);
    expect(toastCalls.error).not.toHaveBeenCalled();
    // Under ONE id, so the pending toast is REPLACED rather than joined.
    expect(toastCalls.success.mock.calls[0][1]).toEqual({ id: toastId() });

    await act(async () => {
      renderer.unmount();
    });
  });

  /**
   * A refused save says so, and the pending toast does not survive it.
   *
   * This is the half two previous verifications missed: they read the outgoing
   * body and never the status. A 400 here has to reach the screen.
   */
  it('replaces the pending toast with an error when the route refuses', async () => {
    patchRequest.mockRejectedValue(
      Object.assign(new Error('Request failed'), {
        response: { status: 400, data: { error: 'Invalid input' } },
      }),
    );
    const { renderer } = await renderEditor();

    await act(async () => {
      systemPromptBox(renderer).onChangeText('you are helpful, and brief');
    });
    await letTimePass(12);

    expect(toastCalls.success).not.toHaveBeenCalled();
    expect(toastCalls.error).toHaveBeenCalledTimes(1);
    expect(toastCalls.dismiss).toHaveBeenCalledWith(toastId());
    // And a refusal does not become a retry storm either.
    expect(patchRequest).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.unmount();
    });
  });
});
