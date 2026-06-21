import * as React from "react";
import { createPortal } from "react-dom";
import { Platform } from "react-native";
import { X } from "lucide-react-native";
import { cn } from "@/lib/utils";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { useTranslation } from "@/hooks/useTranslation";
import { useUIStore } from "@/lib/stores/ui-store";

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPod|iPhone|iPad/.test(navigator.platform);

function modKey(): string {
  return isMac ? "⌘" : "Ctrl";
}

const SHORTCUT_SECTIONS = [
  {
    titleKey: "keyboardShortcuts.navigation",
    shortcuts: [
      { labelKey: "keyboardShortcuts.commandPalette", keys: () => [modKey(), "K"] },
      { labelKey: "keyboardShortcuts.settings", keys: () => [modKey(), ","] },
      { labelKey: "keyboardShortcuts.shortcuts", keys: () => [modKey(), "/"] },
    ],
  },
  {
    titleKey: "keyboardShortcuts.composer",
    shortcuts: [
      { labelKey: "keyboardShortcuts.sendMessage", keys: () => ["Enter"] },
      { labelKey: "keyboardShortcuts.newLine", keys: () => ["⇧", "Enter"] },
    ],
  },
  {
    titleKey: "keyboardShortcuts.conversation",
    shortcuts: [
      { labelKey: "keyboardShortcuts.newChat", keys: () => [modKey(), "⇧", "N"] },
    ],
  },
  {
    titleKey: "keyboardShortcuts.general",
    shortcuts: [
      { labelKey: "keyboardShortcuts.closeDialog", keys: () => ["Esc"] },
    ],
  },
];

export function KeyboardShortcutsDialog() {
  const open = useUIStore((s) => s.shortcutsDialogOpen);
  const setOpen = useUIStore((s) => s.setShortcutsDialogOpen);
  const { t } = useTranslation();

  const [mounted, setMounted] = React.useState(false);
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setMounted(true);
      requestAnimationFrame(() => setVisible(true));
    } else if (mounted) {
      setVisible(false);
      const timer = setTimeout(() => setMounted(false), 150);
      return () => clearTimeout(timer);
    }
  }, [open]);

  React.useEffect(() => {
    if (!mounted) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [mounted, setOpen]);

  if (Platform.OS !== "web" || !mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 isolate">
      {/* Backdrop */}
      <div
        className={cn(
          "fixed inset-0 bg-black/50 transition-opacity duration-150",
          visible ? "opacity-100" : "opacity-0"
        )}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
        }}
      />
      {/* Dialog */}
      <div
        className={cn(
          "fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-background p-6 shadow-lg ring-1 ring-foreground/10 transition-all duration-150",
          visible
            ? "opacity-100 scale-100"
            : "opacity-0 scale-95"
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-foreground">
            {t("keyboardShortcuts.title")}
          </h2>
          <button
            className="rounded-lg p-1 hover:bg-muted text-muted-foreground transition-colors"
            onClick={() => setOpen(false)}
          >
            <X size={20} />
          </button>
        </div>

        {/* Sections */}
        <div className="space-y-5">
          {SHORTCUT_SECTIONS.map((section) => (
            <div key={section.titleKey}>
              <div className="text-xs font-medium text-muted-foreground mb-2">
                {t(section.titleKey)}
              </div>
              <div className="space-y-0.5">
                {section.shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.labelKey}
                    className="flex items-center justify-between py-1.5"
                  >
                    <span className="text-sm text-foreground">
                      {t(shortcut.labelKey)}
                    </span>
                    <KbdGroup>
                      {shortcut.keys().map((key, i) => (
                        <Kbd key={i}>{key}</Kbd>
                      ))}
                    </KbdGroup>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}
