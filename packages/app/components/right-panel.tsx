import { useUIStore } from '@/lib/stores/ui-store';
import { useEffect } from 'react';
import { AgentPanel } from './agent-panel';
import { CanvasPanel } from './canvas-panel';
import { CreditsPanel } from './credits-panel';
import { ThoughtPanel } from './thought-panel';

/** AiChatShell owns resizing, desktop placement and the mobile panel surface. */
export function RightPanel({ width }: { width: number | '100%' }) {
  const setRightPanelWidth = useUIStore((state) => state.setRightPanelWidth);
  useEffect(() => {
    if (typeof width === 'number') setRightPanelWidth(width);
  }, [width, setRightPanelWidth]);
  const panel = useUIStore((state) => state.rightPanel);
  switch (panel) {
    case 'credits':
      return <CreditsPanel />;
    case 'thought':
      return <ThoughtPanel />;
    case 'canvas':
      return <CanvasPanel />;
    case 'agent':
      return <AgentPanel />;
    default:
      return null;
  }
}
