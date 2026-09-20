import { useCallback, useRef } from "react";
import { useUIStore } from "@/lib/stores/ui-store";
import { useTranslation } from "@/lib/hooks/use-translation";
import { CreditsPanel } from "./credits-panel";
import { ThoughtPanel } from "./thought-panel";
import { CanvasPanel } from "./canvas-panel";
import { AgentPanel } from "./agent-panel";
import { Panel } from "./ui/panel";
import { ExecutionSurface } from "./execution/execution-surface";
import { restoreOpenerFocus } from "./execution/focus-return";


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

  /**
   * The width the reader chose, and the drag that changes it.
   *
   * It was two constants — 320, or 420 when the panel held an agent — so how
   * the screen divides was decided once, by us, for everybody. #608 §5 asks
   * for the template's behaviour instead, and the template's panel is dragged.
   *
   * The handle reports a distance from where the drag began, not a width, so
   * the width at the start of the drag is held here and each report is applied
   * to THAT rather than accumulated. Accumulating drifts: the handle re-reports
   * the same total on every pointer move.
   *
   * Dragging left — a negative dx — widens the panel, because the edge being
   * pulled is the panel's inner one.
   */
  const rightPanelWidth = useUIStore((state) => state.rightPanelWidth);
  const setRightPanelWidth = useUIStore((state) => state.setRightPanelWidth);
  const widthAtDragStart = useRef(rightPanelWidth);

  const handleResizeStart = useCallback(() => {
    widthAtDragStart.current = useUIStore.getState().rightPanelWidth;
  }, []);

  const handleResize = useCallback((dx: number) => {
    setRightPanelWidth(widthAtDragStart.current - dx);
  }, [setRightPanelWidth]);

  const handleNudge = useCallback((dx: number) => {
    setRightPanelWidth(useUIStore.getState().rightPanelWidth - dx);
  }, [setRightPanelWidth]);

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
        width={rightPanelWidth}
        divided={false}
        onResizeStart={handleResizeStart}
        onResize={handleResize}
        onNudge={handleNudge}
        resizeLabel={t("panel.resize")}
      >
        {renderPanelContent()}
      </Panel>
    </>
  );
}
