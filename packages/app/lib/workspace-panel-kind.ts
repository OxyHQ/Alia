import type { CanvasArtifact, RightPanel } from '@/lib/stores/ui-store';

/**
 * Which panel the right slot shows. Its own module so that what OPENS the panel
 * (the chat menu, the shell's label) can decide without mounting the panels.
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
