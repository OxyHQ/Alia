import { useTranslation } from '@/lib/hooks/use-translation';
import { useUIStore } from '@/lib/stores/ui-store';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Kbd } from '@oxy.so/bloom/kbd';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { Platform, View } from 'react-native';
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
      <View className="gap-4">
        {SHORTCUT_SECTIONS.map((section) => (
          <SettingsListGroup key={section.titleKey} title={t(section.titleKey)}>
            {section.shortcuts.map((shortcut) => (
              <SettingsListItem
                key={shortcut.labelKey}
                title={t(shortcut.labelKey)}
                showChevron={false}
                rightElement={
                  // One key per cap: `⌘` and `K` are two keys, so two `Kbd`s.
                  <View className="flex-row items-center gap-1">
                    {shortcut.keys().map((key, i) => (
                      <Kbd key={i} size="sm">
                        {key}
                      </Kbd>
                    ))}
                  </View>
                }
              />
            ))}
          </SettingsListGroup>
        ))}
      </View>
    </Dialog>
  );
}
