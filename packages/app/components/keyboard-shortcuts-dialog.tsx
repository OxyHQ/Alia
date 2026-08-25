import * as React from "react";
import { Platform, View } from "react-native";
import { Dialog } from "@oxyhq/bloom/dialog";
import { Text } from "@/components/ui/text";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { useTranslation } from "@/lib/hooks/use-translation";
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

/**
 * The shortcut reference, opened from the sidebar's ⌘ button. Desktop-only:
 * the trigger is web-gated too, and `modKey()` reads `navigator.platform`.
 */
export function KeyboardShortcutsDialog() {
  const open = useUIStore((s) => s.shortcutsDialogOpen);
  const setOpen = useUIStore((s) => s.setShortcutsDialogOpen);
  const { t } = useTranslation();

  if (Platform.OS !== "web") return null;

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      placement={{ base: "bottom", md: "center" }}
      title={t("keyboardShortcuts.title")}
      maxWidth={448}
    >
      <View className="gap-5">
        {SHORTCUT_SECTIONS.map((section) => (
          <View key={section.titleKey}>
            <Text className="text-xs font-medium text-muted-foreground mb-2">
              {t(section.titleKey)}
            </Text>
            <View className="gap-0.5">
              {section.shortcuts.map((shortcut) => (
                <View
                  key={shortcut.labelKey}
                  className="flex-row items-center justify-between py-1.5"
                >
                  <Text className="text-sm text-foreground">
                    {t(shortcut.labelKey)}
                  </Text>
                  <KbdGroup>
                    {shortcut.keys().map((key, i) => (
                      <Kbd key={i}>{key}</Kbd>
                    ))}
                  </KbdGroup>
                </View>
              ))}
            </View>
          </View>
        ))}
      </View>
    </Dialog>
  );
}
