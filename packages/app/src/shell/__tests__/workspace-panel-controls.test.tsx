import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The code and gallery panels draw no control without something behind it
 * (#608 rule 6, §2: "the panels have demo actions and placeholders by default").
 *
 * Bloom's `AiChatCodePanel` and `AiChatGalleryPanel` are mounted for real, so
 * what is asserted is what Bloom ends up drawing from the props Alia hands it:
 * no "Undo changes" or "-0" in the summary, no Browser tab for a code canvas,
 * no Styles tab or "Style presets" placeholder, no new-generation or expand
 * glyph, and every pressable on either panel with a handler — while the
 * controls that remain (closing the panel, a tile's download and its menu) do
 * what they say.
 */

const platform = vi.hoisted(() => ({ OS: 'web' as 'web' | 'ios' | 'android' }));
vi.mock('react-native', async () => (await import('@/shared/testing/native-module-stubs')).reactNativeModule(platform));
vi.mock('react-native-reanimated', async () => (await import('@/shared/testing/native-module-stubs')).reanimatedModule());
vi.mock('react-native-svg', async () => (await import('@/shared/testing/native-module-stubs')).svgModule());
vi.mock('react-native-gesture-handler', async () => (await import('@/shared/testing/native-module-stubs')).gestureHandlerModule());
vi.mock('react-native-screens', async () => (await import('@/shared/testing/native-module-stubs')).screensModule());
vi.mock('react-native-safe-area-context', async () => (await import('@/shared/testing/native-module-stubs')).safeAreaModule());
vi.mock('expo-blur', async () => (await import('@/shared/testing/native-module-stubs')).blurModule());

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => {}),
    removeItem: vi.fn(async () => {}),
  },
}));
vi.mock('expo-router', () => ({ usePathname: () => '/c/one' }));
vi.mock('@oxy.so/services', () => ({ useOxy: () => ({ isAuthenticated: false }) }));
vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params?.name === undefined ? key : `${key}:${String(params.name)}`,
  }),
}));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn(async () => ({})) }));
vi.mock('expo-file-system', () => ({ File: class {}, Paths: {} }));

const saved = vi.hoisted(() => [] as [string, string][]);
vi.mock('@/features/chat/runtime/save-image', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  saveImage: async (uri: string, filename: string) => {
    saved.push([uri, filename]);
  },
}));

const surfaces = vi.hoisted(() => ({
  alerts: [] as { title: string; buttons: { text: string; style?: string; onPress?: () => void }[] }[],
  confirmAnswer: true,
  confirms: [] as { title: string }[],
}));
vi.mock('@oxy.so/bloom/surfaces', () => ({
  alert: (title: string, _message: unknown, buttons: (typeof surfaces.alerts)[number]['buttons']) =>
    surfaces.alerts.push({ title, buttons }),
  confirm: async (options: { title: string }) => {
    surfaces.confirms.push(options);
    return surfaces.confirmAnswer;
  },
}));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { success: () => {}, error: () => {} } }));
vi.mock('@oxy.so/bloom/loading', async () => {
  const { host } = await import('@/shared/testing/panel-bloom-stubs');
  return { Loading: host('Loading') };
});

vi.mock('@/features/chat/ui/workspace/agent-terminal', async () => {
  const { host } = await import('@/shared/testing/panel-bloom-stubs');
  return { AgentTerminal: host('AgentTerminal') };
});
vi.mock('@/features/chat/ui/workspace/agent-panel', () => ({ AgentPanel: () => null }));
vi.mock('@/features/chat/ui/canvas/canvas-component', async () => {
  const { host } = await import('@/shared/testing/panel-bloom-stubs');
  return { CanvasComponent: host('CanvasPreview') };
});
vi.mock('@/features/chat/ui/workspace/credits-limits', () => ({ CreditsLimits: () => null }));
vi.mock('@/features/chat/ui/thought-panel', () => ({ ThoughtPanel: () => null }));

const library = vi.hoisted(() => ({
  files: [] as Record<string, unknown>[],
  deleted: [] as string[],
}));
vi.mock('@/features/library/runtime/library-store', () => {
  const state = {
    get files() {
      return library.files;
    },
    loadFiles: async () => {},
    deleteFile: async (id: string) => {
      library.deleted.push(id);
    },
  };
  return { useLibraryStore: (select: (s: typeof state) => unknown) => select(state) };
});

const { BloomThemeProvider } = await import('@oxy.so/bloom/theme');
const { WorkspacePanel } = await import('@/shell/workspace-panel');
const { useUIStore } = await import('@/features/chat/runtime/ui-store');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;
async function render(): Promise<ReactTestRenderer> {
  await act(async () => {
    renderer = create(
      <BloomThemeProvider mode="light">
        <WorkspacePanel width={410} />
      </BloomThemeProvider>,
    );
  });
  return renderer!;
}

/** Every string drawn, joined — what a reader of the panel sees. */
function texts(r: ReactTestRenderer): string[] {
  const out: string[] = [];
  const walk = (node: ReactTestInstance | string) => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    node.children.forEach(walk);
  };
  walk(r.root);
  return out;
}

const pressables = (r: ReactTestRenderer) => r.root.findAll((n) => (n.type as unknown) === 'Pressable');
const labelled = (r: ReactTestRenderer, label: string) =>
  pressables(r).filter((n) => n.props.accessibilityLabel === label);
const labels = (r: ReactTestRenderer) => pressables(r).map((n) => n.props.accessibilityLabel as string | undefined);

function expectEveryControlActs(r: ReactTestRenderer) {
  for (const node of pressables(r)) {
    expect({ label: node.props.accessibilityLabel, onPress: typeof node.props.onPress }).toEqual({
      label: node.props.accessibilityLabel,
      onPress: 'function',
    });
  }
}

beforeEach(() => {
  platform.OS = 'web';
  library.files = [];
  library.deleted = [];
  saved.length = 0;
  surfaces.alerts = [];
  surfaces.confirms = [];
  surfaces.confirmAnswer = true;
  useUIStore.setState({
    rightPanel: 'canvas',
    agentTerminal: null,
    codePanelView: 'changes',
    canvasArtifacts: [],
  });
});
afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
});

describe('the code panel', () => {
  const code = { id: 'f1', type: 'code' as const, title: 'app.ts', content: { language: 'ts', code: 'a\nb' }, timestamp: 1 };

  it('draws no undo, no deletions and no Browser tab for a code canvas', async () => {
    useUIStore.setState({ canvasArtifacts: [code] });
    const r = await render();
    const drawn = texts(r);
    expect(drawn).toContain('panel.changes');
    expect(drawn).not.toContain('panel.preview');
    expect(drawn).not.toContain('Browser');
    expect(drawn).not.toContain('Browser preview');
    expect(drawn).not.toContain('-0');
    expect(labels(r)).not.toContain('Undo changes');
    // The header: only the glyph that closes the panel.
    expect(labels(r)).not.toContain('Open terminal');
    expect(labels(r)).not.toContain('Expand panel');
    expect(labels(r)).toContain('chatHeader.hidePanel');
    expectEveryControlActs(r);
  });

  it('keeps the Browser view as a stored choice without a tab to show it', async () => {
    useUIStore.setState({ canvasArtifacts: [code], codePanelView: 'preview' });
    const r = await render();
    expect(texts(r)).not.toContain('Browser preview');
    expect(texts(r)).toContain('a');
  });

  it('offers the preview tab for a canvas it can preview', async () => {
    useUIStore.setState({
      canvasArtifacts: [{ id: 'm1', type: 'markdown', title: 'notes.md', content: { content: '# Hi' }, timestamp: 1 }],
      codePanelView: 'preview',
    });
    const r = await render();
    expect(texts(r)).toContain('panel.preview');
    expect(r.root.findAll((n) => (n.type as unknown) === 'CanvasPreview')).toHaveLength(1);
    expectEveryControlActs(r);
  });

  it('closes from its header glyph', async () => {
    useUIStore.setState({ canvasArtifacts: [code] });
    const r = await render();
    await act(async () => labelled(r, 'chatHeader.hidePanel')[0]!.props.onPress());
    expect(useUIStore.getState().rightPanel).toBeNull();
  });
});

describe('the gallery panel', () => {
  const libraryImage = {
    _id: 'lib-1',
    name: 'beach.png',
    url: 'https://media.test/beach.png?sig=1',
    thumbnail: 'https://media.test/beach-thumb.png?sig=1',
    type: 'image/png',
    size: 10,
    category: 'images',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };

  async function renderGallery() {
    useUIStore.setState({ rightPanel: 'gallery' });
    return render();
  }

  it('has no Styles tab, no style presets and no demo header glyphs', async () => {
    library.files = [libraryImage];
    const r = await renderGallery();
    const drawn = texts(r);
    expect(drawn).toContain('panel.gallery');
    expect(drawn).not.toContain('Styles');
    expect(drawn).not.toContain('Style presets');
    expect(labels(r)).not.toContain('New generation');
    expect(labels(r)).not.toContain('Expand panel');
    expect(labels(r)).toContain('chatHeader.hidePanel');
    expectEveryControlActs(r);
  });

  it('downloads a tile as a named file', async () => {
    library.files = [libraryImage];
    const r = await renderGallery();
    await act(async () => labelled(r, 'panel.download:beach.png')[0]!.props.onPress());
    expect(saved).toEqual([['https://media.test/beach.png?sig=1', 'beach.png']]);
  });

  it('draws no download where the platform cannot save a file', async () => {
    platform.OS = 'android';
    library.files = [libraryImage];
    const r = await renderGallery();
    expect(labelled(r, 'panel.download:beach.png')).toHaveLength(0);
    expect(labelled(r, 'panel.more:beach.png')).toHaveLength(1);
    expectEveryControlActs(r);
  });

  it("offers a Library image's real actions, and deletes it once confirmed", async () => {
    library.files = [libraryImage];
    const r = await renderGallery();
    await act(async () => labelled(r, 'panel.more:beach.png')[0]!.props.onPress());
    expect(surfaces.alerts).toHaveLength(1);
    const { title, buttons } = surfaces.alerts[0]!;
    expect(title).toBe('beach.png');
    expect(buttons.map((b) => b.text)).toEqual(['panel.open', 'common.delete', 'common.cancel']);

    await act(async () => buttons[1]!.onPress!());
    expect(surfaces.confirms).toEqual([expect.objectContaining({ title: 'panel.deleteImage:beach.png' })]);
    expect(library.deleted).toEqual(['lib-1']);
  });

  it('draws no more menu when some image has nothing to put in it', async () => {
    useUIStore.setState({
      canvasArtifacts: [
        { id: 'gen-1', type: 'image', title: 'A fox', content: 'data:image/png;base64,AAAA', timestamp: 1 },
      ],
    });
    const r = await renderGallery();
    expect(labelled(r, 'panel.more:A fox')).toHaveLength(0);
    expect(labelled(r, 'panel.download:A fox')).toHaveLength(1);
    expectEveryControlActs(r);
  });
});
