import { AgentPanel } from '@/components/agent-panel';
import { CanvasComponent } from '@/components/canvas/canvas-component';
import { CreditsPanel } from '@/components/credits-panel';
import { ThoughtPanel } from '@/components/thought-panel';
import { useTranslation } from '@/lib/hooks/use-translation';
import { useLibraryStore } from '@/lib/stores/library-store';
import { useUIStore, type CanvasArtifact, type RightPanel } from '@/lib/stores/ui-store';
import {
  AiChatCodePanel,
  AiChatGalleryPanel,
  type AiChatChangedFile,
  type AiChatGeneration,
} from '@oxy.so/bloom/ai-chat';
import type { BloomIconComponent } from '@oxy.so/bloom/icons';
import { RiCodeSLine } from '@oxy.so/bloom/icons/RiCodeSLine';
import { RiGalleryLine } from '@oxy.so/bloom/icons/RiGalleryLine';
import { RiLightbulbLine } from '@oxy.so/bloom/icons/RiLightbulbLine';
import { RiQuillPenLine } from '@oxy.so/bloom/icons/RiQuillPenLine';
import { RiRobot2Line } from '@oxy.so/bloom/icons/RiRobot2Line';
import { useOxy } from '@oxy.so/services';
import { useEffect, useMemo } from 'react';
import { View } from 'react-native';

/**
 * The template's right panel, always mounted from `xl` and a drawer below it.
 *
 * By default it is one of the template's two panels: the code panel over the
 * files Alia wrote in this chat (the canvas), or the gallery over images. The
 * thought, credits and agent panels take the same slot while something has
 * opened them, and give it back when closed.
 */
export type WorkspacePanelKind = 'code' | 'gallery' | 'thought' | 'credits' | 'agent';

export function workspacePanelKind(
  rightPanel: RightPanel,
  artifacts: readonly CanvasArtifact[],
): WorkspacePanelKind {
  if (rightPanel === 'thought' || rightPanel === 'credits' || rightPanel === 'agent') return rightPanel;
  if (rightPanel === 'gallery') return 'gallery';
  if (rightPanel === 'canvas') return 'code';
  return artifacts[artifacts.length - 1]?.type === 'image' ? 'gallery' : 'code';
}

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
        <View style={{ width, minHeight: 0, height: '100%' }}>
          {kind === 'thought' ? <ThoughtPanel /> : kind === 'credits' ? <CreditsPanel /> : <AgentPanel />}
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

  return (
    <AiChatCodePanel
      width={width}
      code={current ? artifactText(current) : t('panel.emptyCanvas')}
      language={current?.type === 'code' ? current.content?.language : undefined}
      changedFiles={changedFiles}
      changeCount={changedFiles.length}
      additions={additions}
      deletions={0}
      browser={
        current && current.type !== 'code' ? (
          <CanvasComponent
            component={{ id: current.id, type: current.type, title: current.title || current.type, data: current.content }}
          />
        ) : undefined
      }
      labels={{ uncommitted: (count) => t('panel.files', { count }) }}
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
