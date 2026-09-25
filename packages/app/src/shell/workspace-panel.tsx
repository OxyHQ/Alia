import { AgentPanel } from '@/features/chat/ui/workspace/agent-panel';
import { CanvasComponent } from '@/features/chat/ui/canvas/canvas-component';
import { CreditsLimits } from '@/features/chat/ui/workspace/credits-limits';
import { ThoughtPanel } from '@/features/chat/ui/thought-panel';
import { useTranslation } from '@/shared/i18n/use-translation';
import { useLibraryStore } from '@/features/library/runtime/library-store';
import { canSaveImage, imageFilename, saveImage } from '@/features/chat/runtime/save-image';
import { useUIStore, type CanvasArtifact, type CodePanelView } from '@/features/chat/runtime/ui-store';
import { workspacePanelKind, type WorkspacePanelKind } from '@/features/chat/model/workspace-panel-kind';
import {
  AiChatCodePanel,
  AiChatGalleryPanel,
  type AiChatChangedFile,
  type AiChatCodePanelLabels,
  type AiChatGalleryPanelLabels,
  type AiChatGeneration,
  type AiChatPanelAction,
} from '@oxy.so/bloom/ai-chat';
import type { BloomIconComponent } from '@oxy.so/bloom/icons';
import { RiCodeSLine } from '@oxy.so/bloom/icons/RiCodeSLine';
import { RiGalleryLine } from '@oxy.so/bloom/icons/RiGalleryLine';
import { RiLightbulbLine } from '@oxy.so/bloom/icons/RiLightbulbLine';
import { RiQuillPenLine } from '@oxy.so/bloom/icons/RiQuillPenLine';
import { RiRobot2Line } from '@oxy.so/bloom/icons/RiRobot2Line';
import { RiSideBarLine } from '@oxy.so/bloom/icons/RiSideBarLine';
import { RiTerminalBoxLine } from '@oxy.so/bloom/icons/RiTerminalBoxLine';
import { Loading } from '@oxy.so/bloom/loading';
import { alert, confirm, type AlertButton } from '@oxy.so/bloom/surfaces';
import { toast } from '@oxy.so/bloom/toast';
import { useOxy } from '@oxy.so/services';
import { usePathname } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { lazy, Suspense, useCallback, useEffect, useMemo } from 'react';
import { Platform, View } from 'react-native';

/**
 * The agent's terminal, loaded when it is first shown: it brings xterm (web)
 * or a WebView (native) with it, which a chat that never opens it should not
 * pay for.
 */
const AgentTerminal = lazy(() =>
  import('@/features/chat/ui/workspace/agent-terminal').then((m) => ({ default: m.AgentTerminal })),
);

/**
 * The right panel: in flow from `xl`, a drawer below it — and only while
 * something has opened it (`rightPanel`), so a plain conversation has the
 * whole width.
 *
 * What opens it: the agent at work (its first tool of a turn opens the thought
 * panel, a file it writes the canvas, a run the agent panel), the chat menu's
 * "Show panel" (the code panel over the files Alia wrote in this chat, or the
 * gallery over images) and "Agent terminal" (the code panel's second tab), and
 * the credits page.
 */
const PANEL_ICON: Record<WorkspacePanelKind, BloomIconComponent> = {
  code: RiCodeSLine,
  gallery: RiGalleryLine,
  thought: RiLightbulbLine,
  credits: RiQuillPenLine,
  agent: RiRobot2Line,
};

/** The label and glyph the shell shows for the panel (drawer header, open button). */
export function useWorkspacePanelChrome(): { label: string; icon: BloomIconComponent } {
  const { t } = useTranslation();
  const rightPanel = useUIStore((s) => s.rightPanel);
  const artifacts = useUIStore((s) => s.canvasArtifacts);
  const kind = workspacePanelKind(rightPanel, artifacts);
  const label =
    kind === 'thought' ? t('thought.title') : t(`panel.${kind}`);
  return { label, icon: PANEL_ICON[kind] };
}

const FILL = { minHeight: 0, flex: 1, height: undefined } as const;

export function WorkspacePanel({ width }: { width: number | '100%' }) {
  const setRightPanelWidth = useUIStore((s) => s.setRightPanelWidth);
  useEffect(() => {
    if (typeof width === 'number') setRightPanelWidth(width);
  }, [width, setRightPanelWidth]);

  const rightPanel = useUIStore((s) => s.rightPanel);
  const artifacts = useUIStore((s) => s.canvasArtifacts);
  const kind = workspacePanelKind(rightPanel, artifacts);
  const style = width === '100%' ? FILL : undefined;

  switch (kind) {
    case 'thought':
    case 'credits':
    case 'agent':
      return (
        <View className="h-full min-h-0" style={{ width }}>
          {kind === 'thought' ? <ThoughtPanel /> : kind === 'credits' ? <CreditsLimits /> : <AgentPanel />}
        </View>
      );
    case 'gallery':
      return <GalleryPanel width={width} style={style} />;
    default:
      return <CodePanel width={width} style={style} artifacts={artifacts} />;
  }
}

function lineCount(text: string): number {
  return text === '' ? 0 : text.split('\n').length;
}

function artifactText(artifact: CanvasArtifact): string {
  const c = artifact.content;
  if (typeof c === 'string') return c;
  if (typeof c?.code === 'string') return c.code;
  if (typeof c?.content === 'string') return c.content;
  return '';
}

/** The code panel's Bloom tab for each of its views: the terminal rides in the second one. */
function tabOf(view: CodePanelView): 'changes' | 'browser' {
  return view === 'changes' ? 'changes' : 'browser';
}

function CodePanel({
  width,
  style,
  artifacts,
}: {
  width: number | '100%';
  style?: typeof FILL;
  artifacts: readonly CanvasArtifact[];
}) {
  const { t } = useTranslation();
  const files = artifacts.filter((a) => a.type !== 'image');
  const current = files[files.length - 1];
  const changedFiles = useMemo<AiChatChangedFile[]>(
    () =>
      files.map((a) => ({
        path: a.title || a.type,
        additions: lineCount(artifactText(a)),
        status: t('panel.new'),
      })),
    [files, t],
  );
  const additions = changedFiles.reduce((sum, f) => sum + (f.additions ?? 0), 0);

  /**
   * The agent terminal, as the second tab of this panel — only on the route it
   * was opened from (see `AgentTerminalSelection`).
   */
  const pathname = usePathname();
  const terminal = useUIStore((s) => s.agentTerminal);
  const terminalAgentId = terminal !== null && terminal.route === pathname ? terminal.agentId : null;
  const storedView = useUIStore((s) => s.codePanelView);
  const setView = useUIStore((s) => s.setCodePanelView);
  const view: CodePanelView = storedView === 'terminal' && terminalAgentId === null ? 'preview' : storedView;
  const showTerminal = view === 'terminal' && terminalAgentId !== null;

  /**
   * The header's glyphs, each with something behind it. Bloom's defaults are a
   * terminal, an expand and a toggle with no handlers; the terminal is offered
   * only where there is an agent to show, and expand has nothing to do here.
   */
  const actions = useMemo<AiChatPanelAction[]>(
    () => [
      ...(terminalAgentId === null
        ? []
        : [
            {
              key: 'terminal',
              label: t('panel.terminal'),
              icon: RiTerminalBoxLine,
              onPress: () => setView(view === 'terminal' ? 'preview' : 'terminal'),
            },
          ]),
      {
        key: 'toggle',
        label: t('chatHeader.hidePanel'),
        icon: RiSideBarLine,
        onPress: () => useUIStore.getState().setRightPanel(null),
      },
    ],
    [terminalAgentId, view, setView, t],
  );

  const labels = useMemo<AiChatCodePanelLabels>(
    () => ({
      changes: t('panel.changes'),
      browser: showTerminal ? t('panel.terminal') : t('panel.preview'),
      tabs: t('panel.views'),
      uncommitted: (count) => t('panel.files', { count }),
    }),
    [showTerminal, t],
  );

  /**
   * The second tab exists only with something in it: the terminal, or the
   * preview of a canvas that is not code (the Changes tab already shows code).
   * Otherwise `null`, and Bloom draws no tab rather than a "Browser preview"
   * placeholder for a browser Alia does not have.
   */
  const second = showTerminal ? (
    <View className="min-h-0 flex-1" testID="agent-terminal-slot">
      <Suspense fallback={<Loading />}>
        <AgentTerminal agentId={terminalAgentId} />
      </Suspense>
    </View>
  ) : current && current.type !== 'code' ? (
    <CanvasComponent
      component={{ id: current.id, type: current.type, title: current.title || current.type, data: current.content }}
    />
  ) : null;

  return (
    <AiChatCodePanel
      width={width}
      code={current ? artifactText(current) : t('panel.emptyCanvas')}
      language={current?.type === 'code' ? current.content?.language : undefined}
      changedFiles={changedFiles}
      changeCount={changedFiles.length}
      additions={additions}
      tab={tabOf(view)}
      onTabChange={(tab) =>
        setView(tab === 'changes' ? 'changes' : view === 'terminal' ? 'terminal' : 'preview')
      }
      actions={actions}
      browser={second}
      labels={labels}
      style={style}
    />
  );
}

/** An http(s) address: what can be opened outside the app (a data URI cannot). */
function isRemote(uri: string): boolean {
  return /^https?:\/\//i.test(uri);
}

/** Open an image the way sources open: a new tab on web, the in-app browser on native. */
function openImage(uri: string): void {
  if (Platform.OS === 'web') window.open(uri, '_blank', 'noopener,noreferrer');
  else void WebBrowser.openBrowserAsync(uri);
}

/** A tile, and the Library file it is when it is one (only those can be deleted). */
interface GalleryTile extends AiChatGeneration {
  uri: string;
  libraryId?: string;
}

/**
 * The gallery: the images this chat's canvas holds, then the Library's.
 *
 * Every control on it does something (#608 rule 6). The header has only the
 * sidebar glyph that closes the panel — Bloom's default "new generation" and
 * "expand" have nothing behind them here. There is no Styles tab
 * (`stylePresets={null}`): Alia has no style presets, and a placeholder would
 * pretend to a style editor. A tile's download saves the image where this
 * platform can (`canSaveImage()`), and its more menu offers what exists for that
 * image: opening it and, for a Library file, deleting it.
 */
function GalleryPanel({ width, style }: { width: number | '100%'; style?: typeof FILL }) {
  const { t } = useTranslation();
  const files = useLibraryStore((s) => s.files);
  const loadFiles = useLibraryStore((s) => s.loadFiles);
  const deleteFile = useLibraryStore((s) => s.deleteFile);
  const artifacts = useUIStore((s) => s.canvasArtifacts);
  const { isAuthenticated } = useOxy();
  useEffect(() => {
    if (isAuthenticated) void loadFiles();
  }, [isAuthenticated, loadFiles]);

  // A tile with no address has nothing to show, save or open: it is left out
  // rather than drawn as an empty wash.
  const generated = useMemo<GalleryTile[]>(
    () =>
      artifacts.flatMap((a) => {
        if (a.type !== 'image') return [];
        const uri: unknown = typeof a.content === 'string' ? a.content : a.content?.url;
        return typeof uri === 'string' && uri !== ''
          ? [{ id: a.id, prompt: a.title || '', uri, source: { uri }, aspectRatio: 1 }]
          : [];
      }),
    [artifacts],
  );
  const generations = useMemo<GalleryTile[]>(
    () =>
      files.flatMap((f) => {
        const uri = f.url || f.thumbnail;
        if (f.category !== 'images' || !uri) return [];
        return [{ id: f._id, prompt: f.name, uri, libraryId: f._id, source: { uri: f.thumbnail || uri }, aspectRatio: 1 }];
      }),
    [files],
  );

  const actions = useMemo<AiChatPanelAction[]>(
    () => [
      {
        key: 'toggle',
        label: t('chatHeader.hidePanel'),
        icon: RiSideBarLine,
        onPress: () => useUIStore.getState().setRightPanel(null),
      },
    ],
    [t],
  );

  const labels = useMemo<AiChatGalleryPanelLabels>(
    () => ({
      gallery: t('panel.gallery'),
      tabs: t('panel.views'),
      enlarge: (name) => t('panel.enlarge', { name }),
      minimize: (name) => t('panel.minimize', { name }),
      download: (name) => t('panel.download', { name }),
      more: (name) => t('panel.more', { name }),
    }),
    [t],
  );

  const tiles = useMemo(() => new Map([...generated, ...generations].map((g) => [g.id, g])), [generated, generations]);

  const onDownload = useCallback(
    (generation: AiChatGeneration) => {
      const tile = tiles.get(generation.id);
      if (tile === undefined) return;
      saveImage(tile.uri, imageFilename(tile.prompt, tile.uri)).catch(() => toast.error(t('panel.downloadFailed')));
    },
    [tiles, t],
  );

  const remove = useCallback(
    async (tile: GalleryTile) => {
      if (tile.libraryId === undefined) return;
      const ok = await confirm({
        title: t('panel.deleteImage', { name: tile.prompt }),
        description: t('panel.deleteImageDescription'),
        confirmLabel: t('common.delete'),
        cancelLabel: t('common.cancel'),
        destructive: true,
      });
      if (!ok) return;
      try {
        await deleteFile(tile.libraryId);
        toast.success(t('library.fileDeleted'));
      } catch {
        toast.error(t('library.failedDeleteFile'));
      }
    },
    [deleteFile, t],
  );

  /** What the more menu holds for a tile; a tile with nothing in it gets no menu. */
  const moreButtons = useCallback(
    (tile: GalleryTile): AlertButton[] => [
      ...(isRemote(tile.uri) ? [{ text: t('panel.open'), onPress: () => openImage(tile.uri) }] : []),
      ...(tile.libraryId !== undefined
        ? [{ text: t('common.delete'), style: 'destructive' as const, onPress: () => void remove(tile) }]
        : []),
    ],
    [remove, t],
  );
  // Bloom draws the more action on every tile or on none, so it is offered
  // only when every tile has something to put in it.
  const everyTileHasMore = [...tiles.values()].every((tile) => moreButtons(tile).length > 0);
  const onMore = useCallback(
    (generation: AiChatGeneration) => {
      const tile = tiles.get(generation.id);
      if (tile === undefined) return;
      alert(tile.prompt || t('panel.gallery'), undefined, [
        ...moreButtons(tile),
        { text: t('common.cancel'), style: 'cancel' },
      ]);
    },
    [tiles, moreButtons, t],
  );

  return (
    <AiChatGalleryPanel
      width={width}
      generations={generations}
      generated={generated}
      actions={actions}
      stylePresets={null}
      onDownload={canSaveImage() ? onDownload : undefined}
      onMore={everyTileHasMore ? onMore : undefined}
      labels={labels}
      style={style}
    />
  );
}
