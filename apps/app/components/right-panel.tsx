import { useWindowDimensions } from "react-native";
import { useUIStore } from "@/lib/stores/ui-store";
import { CreditsPanel } from "./credits-panel";
import { ThoughtPanel } from "./thought-panel";
import { CanvasPanel } from "./canvas-panel";
import { Panel } from "./ui/panel";

const PANEL_WIDTH = 320;

export function RightPanel() {
  const { width } = useWindowDimensions();
  const isLargeScreen = width >= 768;
  const rightPanel = useUIStore((state) => state.rightPanel);
  const setRightPanel = useUIStore((state) => state.setRightPanel);

  const isOpen = rightPanel !== null;

  const handleClose = () => {
    setRightPanel(null);
  };

  const renderPanelContent = () => {
    switch (rightPanel) {
      case "credits":
        return <CreditsPanel />;
      case "thought":
        return <ThoughtPanel />;
      case "canvas":
        return <CanvasPanel />;
      default:
        return null;
    }
  };

  return (
    <Panel
      open={isOpen}
      onClose={handleClose}
      side="right"
      width={PANEL_WIDTH}
    >
      {renderPanelContent()}
    </Panel>
  );
}
