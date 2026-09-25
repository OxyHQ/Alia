import { AgentPanel } from '@/features/chat/ui/workspace/agent-panel';
import { CanvasComponent } from '@/features/chat/ui/canvas/canvas-component';
import { CreditsLimits } from '@/features/chat/ui/workspace/credits-limits';
import { ThoughtPanel } from '@/features/chat/ui/thought-panel';
import { useTranslation } from '@/shared/i18n/use-translation';
import { useLibraryStore } from '@/features/library/runtime/library-store';
import { useUIStore, type CanvasArtifact, type CodePanelView } from '@/features/chat/runtime/ui-store';
import { workspacePanelKind, type WorkspacePanelKind } from '@/features/chat/model/workspace-panel-kind';
import {
  AiChatCodePanel,
  AiChatGalleryPanel,
  type AiChatChangedFile,
  type AiChatCodePanelLabels,
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
import { useOxy } from '@oxy.so/services';
import { usePathname } from 'expo-router';
import { lazy, Suspense, useEffect, useMemo } from 'react';
import { View } from 'react-native';

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
      uncommitted: (count) => t('panel.files', { count }),
      ...(showTerminal ? { browser: t('panel.terminal') } : {}),
    }),
    [showTerminal, t],
  );

  return (
    <AiChatCodePanel
      width={width}
      code={current ? artifactText(current) : t('panel.emptyCanvas')}
      language={current?.type === 'code' ? current.content?.language : undefined}
      changedFiles={changedFiles}
      changeCount={changedFiles.length}
      additions={additions}
      deletions={0}
      tab={tabOf(view)}
      onTabChange={(tab) =>
        setView(tab === 'changes' ? 'changes' : view === 'terminal' ? 'terminal' : 'preview')
      }
      actions={actions}
      browser={
        showTerminal ? (
          <View className="min-h-0 flex-1" testID="agent-terminal-slot">
            <Suspense fallback={<Loading />}>
              <AgentTerminal agentId={terminalAgentId} />
            </Suspense>
          </View>
        ) : current && current.type !== 'code' ? (
          <CanvasComponent
            component={{ id: current.id, type: current.type, title: current.title || current.type, data: current.content }}
          />
        ) : undefined
      }
      labels={labels}
      style={style}
    />
  );
}

function GalleryPanel({ width, style }: { width: number | '100%'; style?: typeof FILL }) {
  const files = useLibraryStore((s) => s.files);
  const loadFiles = useLibraryStore((s) => s.loadFiles);
  const artifacts = useUIStore((s) => s.canvasArtifacts);
  const { isAuthenticated } = useOxy();
  useEffect(() => {
    if (isAuthenticated) void loadFiles();
  }, [isAuthenticated, loadFiles]);

  const generated = useMemo<AiChatGeneration[]>(
    () =>
      artifacts
        .filter((a) => a.type === 'image')
        .map((a) => ({
          id: a.id,
          prompt: a.title || '',
          source: { uri: typeof a.content === 'string' ? a.content : a.content?.url },
          aspectRatio: 1,
        })),
    [artifacts],
  );
  const generations = useMemo<AiChatGeneration[]>(
    () =>
      files
        .filter((f) => f.category === 'images')
        .map((f) => ({ id: f._id, prompt: f.name, source: { uri: f.thumbnail || f.url }, aspectRatio: 1 })),
    [files],
  );

  return <AiChatGalleryPanel width={width} generations={generations} generated={generated} style={style} />;
}
