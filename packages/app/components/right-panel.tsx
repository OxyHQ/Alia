import { useCallback } from "react";
import { useUIStore } from "@/lib/stores/ui-store";
import { useTranslation } from "@/lib/hooks/use-translation";
import { CreditsPanel } from "./credits-panel";
import { ThoughtPanel } from "./thought-panel";
import { CanvasPanel } from "./canvas-panel";
import { AgentPanel } from "./agent-panel";
import { Panel } from "./ui/panel";
import { ExecutionSurface } from "./execution/execution-surface";
import { restoreOpenerFocus } from "./execution/focus-return";

const PANEL_WIDTH = 320;
const AGENT_PANEL_WIDTH = 420;

/**
 * The right-hand panel: one of the four the store names, or nothing.
 *
 * The thought (execution) panel has its own surface — the 300px rail with
 * 16px gutters below the header on a wide screen, the in-viewport 300px
 * popover on a narrow one (#544) — and it hands focus back to the row that
 * opened it. The other three keep the generic side panel. Both surfaces are
 * mounted with `open` rather than swapped, so each can play its exit.
 */
export function RightPanel() {
  const { t } = useTranslation();
  const rightPanel = useUIStore((state) => state.rightPanel);
  const setRightPanel = useUIStore((state) => state.setRightPanel);

  const isThought = rightPanel === "thought";
  const isOpen = rightPanel !== null && !isThought;
  const panelWidth = rightPanel === "agent" ? AGENT_PANEL_WIDTH : PANEL_WIDTH;

  const handleClose = useCallback(() => {
    setRightPanel(null);
  }, [setRightPanel]);

  const handleCloseThought = useCallback(() => {
    setRightPanel(null);
    restoreOpenerFocus();
  }, [setRightPanel]);

  const renderPanelContent = () => {
    switch (rightPanel) {
      case "credits":
        return <CreditsPanel />;
      case "canvas":
        return <CanvasPanel />;
      case "agent":
        return <AgentPanel />;
      default:
        return null;
    }
  };

  return (
    <>
      <ExecutionSurface open={isThought} onClose={handleCloseThought} label={t("thought.title")}>
        {isThought ? <ThoughtPanel /> : null}
      </ExecutionSurface>
      <Panel
        open={isOpen}
        onClose={handleClose}
        side="right"
        width={panelWidth}
        divided={false}
      >
        {renderPanelContent()}
      </Panel>
    </>
  );
}
