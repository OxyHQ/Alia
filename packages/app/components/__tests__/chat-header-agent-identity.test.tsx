import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The template action menu preserves search routing and remains memoized during streaming. */

const menuControls = vi.hoisted(() => ({ confirm: vi.fn(async () => false), panel: vi.fn() }));

const renders = { credits: 0 };

/** The theme's own, which an agent Oxy could not resolve is drawn in. */
const MUTED = "rgb(113 113 122)";

vi.mock("react-native", async () => {
  const ReactModule = await import("react");
  return {
    Platform: {
      OS: "web",
      select: (spec: Record<string, unknown>) => spec.web,
    },
    View: ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement("View", props, children),
  };
});

/**
 * The header's three glyphs, one module each.
 *
 * Stubbed rather than rendered because each is a real `react-native-svg` tree,
 * which this runner cannot parse — and because what is under test is the button
 * the magnifier sits in, not the magnifier. `Search` keeps its host name, so the
 * assertions below still address the same node they always did.
 *
 * Three literal factories rather than one helper: `vi.mock` is hoisted above
 * everything else in the file, so a factory that closes over a `const` is
 * called before that `const` exists.
 */
vi.mock("@/components/ui/icons/search-icon", async () => {
  const ReactModule = await import("react");
  return {
    SearchIcon: (props: Record<string, unknown>) =>
      ReactModule.createElement("Search", props),
  };
});

vi.mock("@/components/ui/icons/menu-icon", async () => {
  const ReactModule = await import("react");
  return {
    MenuIcon: (props: Record<string, unknown>) =>
      ReactModule.createElement("Menu", props),
  };
});

vi.mock("@/components/ui/icons/dots-horizontal-icon", async () => {
  const ReactModule = await import("react");
  return {
    DotsHorizontalIcon: (props: Record<string, unknown>) =>
      ReactModule.createElement("DotsHorizontal", props),
  };
});

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("@/components/ui/ghost-icon", async () => {
  const ReactModule = await import("react");
  return {
    GhostIcon: (props: Record<string, unknown>) =>
      ReactModule.createElement("GhostIcon", props),
  };
});

vi.mock("@oxy.so/bloom/page-header", async () => {
  const R = await import("react");
  return {
    PageHeader: ({ title, leading, actions }: any) =>
      R.createElement("PageHeader", null, title, leading, actions),
  };
});
vi.mock("@/components/settings/settings-context", () => ({
  useAliaSettings: () => ({ open: () => {} }),
}));
vi.mock("@oxy.so/bloom/button", async () => {
  const ReactModule = await import("react");
  return {
    Button: ({
      children,
      icon,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(
        "Button",
        props,
        icon as React.ReactNode,
        children,
      ),
  };
});

vi.mock("@oxy.so/bloom/typography", async () => {
  const ReactModule = await import("react");
  return {
    Text: ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement("Text", props, children),
  };
});

vi.mock("@alia.onl/sdk", async () => {
  const ReactModule = await import("react");
  return {
    IdentityMark: (props: Record<string, unknown>) =>
      ReactModule.createElement("IdentityMark", props),
  };
});

vi.mock("@/lib/useColorScheme", () => ({
  useColorScheme: () => ({ colors: { mutedForeground: MUTED } }),
}));

/**
 * Bloom's `theme` entry is a barrel that reaches `react-native`, which has no
 * Node build. The colour utilities and the preset registry are standalone
 * modules in the SAME install, so the header resolves the agent's colour through
 * Bloom's OWN `parseRgb` and `APP_COLOR_PRESETS` here — which is what makes the
 * assertions below about a painted colour rather than a value passed along.
 */
vi.mock("@oxy.so/bloom/theme", async () => {
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const require = createRequire(import.meta.url);
  const entry = pathToFileURL(require.resolve("@oxy.so/bloom"));
  const from = (module: string) =>
    require(new URL(`theme/${module}.js`, entry).pathname);
  return { ...from("color-utils"), ...from("color-presets") };
});

/**
 * The render counter hangs off this one because it is always mounted, in both
 * the agent and the plain case — so a count of 1 means the whole header
 * rendered once, not that a conditional branch happened to be skipped.
 */
vi.mock("@/components/credits-menu", async () => {
  const ReactModule = await import("react");
  return {
    CreditsMenu: () => {
      renders.credits += 1;
      return ReactModule.createElement("CreditsMenu", null);
    },
  };
});

vi.mock("expo-router", () => ({
  useNavigation: () => ({ toggleDrawer: () => {} }),
  useRouter: () => ({ push: () => {} }),
}));

vi.mock("@oxy.so/bloom/dropdown-menu", async () => {
  const ReactModule = await import("react");
  const host =
    (name: string) =>
    ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return {
    DropdownMenu: host("DropdownRoot"),
    DropdownMenuTrigger: host("DropdownTrigger"),
    DropdownMenuContent: host("DropdownContent"),
    DropdownMenuItem: host("DropdownItem"),
    DropdownMenuCheckboxItem: host("DropdownCheckboxItem"),
    DropdownMenuSeparator: host("DropdownSeparator"),
  };
});

vi.mock("@oxy.so/bloom/toast", () => ({ toast: { info: () => {} } }));
vi.mock("@oxy.so/bloom/surfaces", () => ({ confirm: menuControls.confirm }));
vi.mock("@/lib/hooks/use-translation", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { ChatHeader } from "../chat-header";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;

function render(element: React.ReactElement) {
  let next: ReactTestRenderer | undefined;
  act(() => {
    next = create(element);
  });
  if (next === undefined) throw new Error("ChatHeader did not render");
  renderer = next;
  return next;
}

function nodes(r: ReactTestRenderer, name: string) {
  return r.root.findAll((node) => node.type === name);
}

beforeEach(() => {
  renders.credits = 0;
});

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
});

describe("the magnifier", () => {
  /**
   * Two searches share one button, and which one it opens is the whole
   * question: a thread searches what was SAID in it, everywhere else the
   * app-wide palette finds a chat.
   *
   * `document` and `KeyboardEvent` are stubbed because this suite runs without
   * a DOM — the palette branch reaches for both, so the stub is what makes
   * "which branch ran" observable rather than a crash.
   */
  const dispatched: { key: string; metaKey: boolean }[] = [];

  beforeEach(() => {
    dispatched.length = 0;
    Object.assign(globalThis, {
      document: {
        dispatchEvent: (event: { key: string; metaKey: boolean }) =>
          dispatched.push(event),
      },
      KeyboardEvent: class {
        key: string;
        metaKey: boolean;
        constructor(_type: string, init: { key: string; metaKey: boolean }) {
          this.key = init.key;
          this.metaKey = init.metaKey;
        }
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(globalThis, "KeyboardEvent");
  });

  /** The button the magnifier sits in — `nodes` takes a string so `type` stays wide. */
  function pressSearch(r: ReactTestRenderer) {
    const button = nodes(r, "DropdownItem").find((node) =>
      ["chatHeader.searchThread", "chatHeader.searchConversations"].includes(
        node.props.children,
      ),
    );
    if (button === undefined)
      throw new Error("the magnifier is not in a button");
    act(() => button.props.onPress());
  }

  it("searches the thread when a thread gave it a handler", () => {
    const onSearchPress = vi.fn();
    pressSearch(render(<ChatHeader onSearchPress={onSearchPress} />));

    expect(onSearchPress).toHaveBeenCalledTimes(1);
    // And the app-wide palette stays shut: two searches opening at once is one
    // too many, and the one that covers the screen is not the one asked for.
    expect(dispatched).toEqual([]);
  });

  it("opens the app-wide palette everywhere else", () => {
    pressSearch(render(<ChatHeader />));

    expect(dispatched).toEqual([{ key: "k", metaKey: true }]);
  });
});

describe("the chat header, while an answer streams", () => {
  const STREAMING_FLUSHES = 20;

  it("renders once across a whole stream", () => {
    const onGhostModePress = () => {};
    const header = () => <ChatHeader onGhostModePress={onGhostModePress} />;

    const r = render(header());
    for (let i = 0; i < STREAMING_FLUSHES; i++) {
      act(() => r.update(header()));
    }

    expect(renders.credits).toBe(1);
  });

  it("re-renders on every flush the moment one prop stops comparing by value", () => {
    // The control for the assertion above: without it, "rendered once" could
    // just as well mean the harness cannot see a re-render at all. A fresh
    // arrow per render is the realistic way this breaks — an inline
    // `onGhostModePress={() => …}` or an inline identity object at the call
    // site — and it costs exactly one full header render per streaming flush.
    const r = render(<ChatHeader onGhostModePress={() => {}} />);
    for (let i = 0; i < STREAMING_FLUSHES; i++) {
      act(() => r.update(<ChatHeader onGhostModePress={() => {}} />));
    }

    expect(renders.credits).toBe(STREAMING_FLUSHES + 1);
  });
});

/**
 * The memo above is only worth anything if the CALL SITE keeps its side of the
 * bargain, and no render-count test of the component can see that: it renders
 * the props it was handed. So the call site is read.
 */
describe("the call site in chat-page-content", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../chat-page-content.tsx", import.meta.url)),
    "utf8",
  );

  /** The `<ChatHeader … />` element, whole. */
  function chatHeaderElement(text: string): string {
    const start = text.indexOf("<ChatHeader");
    if (start === -1) throw new Error("no <ChatHeader> element in the source");
    const end = text.indexOf("/>", start);
    if (end === -1)
      throw new Error("the <ChatHeader> element is not self-closing");
    return text.slice(start, end + 2);
  }

  /** A prop value that is built fresh on every render, and so defeats the memo. */
  const FRESHLY_BUILT = /=\{\s*[{[(]/;

  it("hands the header no value that is rebuilt per render", () => {
    const element = chatHeaderElement(source);

    // Positive control on the extractor itself: an assertion over an empty
    // string would pass, and would keep passing after the element was renamed.
    expect(element).toContain("onSearchPress={onSearchPress}");
    expect(element).not.toMatch(FRESHLY_BUILT);
  });

  it("would catch an unstable callback written inline", () => {
    // The same predicate against the thing it exists to reject.
    const broken = source.replace(
      "onSearchPress={onSearchPress}",
      "onSearchPress={() => onSearchPress()}",
    );

    expect(chatHeaderElement(broken)).toMatch(FRESHLY_BUILT);
  });
});

vi.mock("@oxy.so/bloom/icons", () => ({
  RiMoreFill: () => null,
  RiDeleteBinLine: () => null,
  RiDownloadLine: () => null,
  RiSettings3Line: () => null,
}));

vi.mock("@/lib/hooks/use-credits", () => ({
  useCredits: () => {
    renders.credits += 1;
    return { data: { credits: 12 } };
  },
}));
vi.mock("@oxy.so/services", () => ({
  useAuth: () => ({ isAuthenticated: true }),
}));
vi.mock("@/lib/stores/ui-store", () => ({
  useUIStore: (select: any) => select({ toggleRightPanel: menuControls.panel }),
}));

describe('template action menu callbacks', () => {
  it('keeps ghost and export actions attached to their owners', () => {
    const ghost = vi.fn();
    const first = render(<ChatHeader onGhostModePress={ghost} />);
    const ghostItem = nodes(first, 'DropdownCheckboxItem').find(node => JSON.stringify(node.props.children).includes('chatHeader.temporaryChat'))!;
    act(() => ghostItem.props.onCheckedChange(true));
    expect(ghost).toHaveBeenCalledTimes(1);
    const exportChat = vi.fn();
    const conversation = render(<ChatHeader isConversation onExport={exportChat} />);
    act(() => nodes(conversation, 'DropdownItem').find(node => node.props.children === 'chatHeader.export')!.props.onPress());
    expect(exportChat).toHaveBeenCalledTimes(1);
  });
  it('opens the existing credits panel', () => {
    menuControls.panel.mockClear();
    const r = render(<ChatHeader />);
    act(() => nodes(r, 'DropdownItem').find(node => JSON.stringify(node.props.children).includes('Credits'))!.props.onPress());
    expect(menuControls.panel).toHaveBeenCalledWith('credits');
  });
  it('requires confirmation before clearing the conversation', async () => {
    const clear = vi.fn();
    const r = render(<ChatHeader isConversation onClear={clear} />);
    const item = nodes(r, 'DropdownItem').find(node => node.props.children === 'chatHeader.clearConversation')!;
    menuControls.confirm.mockResolvedValueOnce(false);
    await act(async () => { await item.props.onPress(); });
    expect(clear).not.toHaveBeenCalled();
    menuControls.confirm.mockResolvedValueOnce(true);
    await act(async () => { await item.props.onPress(); });
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
