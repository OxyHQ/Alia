import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { DrawerToggle } from "@/components/ui/drawer-toggle";
import { useRouter } from "expo-router";
import { ArrowLeft } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSettingsLayoutMode } from "@/components/settings/layout-mode";
import { useTranslation } from "@/lib/hooks/use-translation";

interface SettingsHeaderProps {
  title: string;
  subtitle?: string;
  showBack?: boolean;
  onBack?: () => void;
}

/** The toolbar row: one 36px control with 10px above and below it. */
const TOOLBAR_HEIGHT = 56;
const TOOLBAR_PADDING = 10;

/**
 * Header of every settings screen: the drawer opener, the way back to the
 * category menu, the title, and under the title an optional subtitle.
 *
 * As tall as its content and never shorter than the toolbar. It used to be
 * exactly `56 + insets.top` tall with its row centred, and a title (28px) over
 * a subtitle wrapped to two lines (40px) is 68px: the overflow split above and
 * below, and the top of the title sat above y = 0 — Connectors at 390×844 and
 * at 320×740 (#550). The controls are pinned to the toolbar row rather than to
 * the centre of whatever the text block became, so they stay level with the
 * title line however long the subtitle runs.
 */
export function SettingsHeader({ title, subtitle, showBack = false, onBack }: SettingsHeaderProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const mode = useSettingsLayoutMode();

  /**
   * Back leads to the category menu, which is a screen of its own only in
   * stacked mode: in split mode the column beside this pane IS the menu, and the
   * index this would return to redirects straight here again. Not `md:hidden`,
   * which it was — at 768 with the drawer open the layout is stacked and the
   * button was hidden all the same, leaving a tablet no way from a section back
   * to the list (#548). Hidden while the scene is unmeasured, so it never shows
   * up only to vanish.
   */
  const backVisible = showBack && mode === "stacked";

  const handleBack = () => {
    if (onBack) {
      onBack();
    } else if (router.canGoBack()) {
      router.back();
    } else {
      // Opened straight from a link: there is no menu to pop back to yet.
      router.replace("/(app)/settings");
    }
  };

  return (
    <View
      className="flex-row items-start gap-2 px-4 border-b border-border"
      style={{
        paddingTop: insets.top + TOOLBAR_PADDING,
        paddingBottom: TOOLBAR_PADDING,
        minHeight: TOOLBAR_HEIGHT + insets.top,
      }}
    >
      <DrawerToggle />
      {backVisible && (
        <Button
          variant="ghost"
          size="icon"
          onPress={handleBack}
          accessibilityRole="button"
          accessibilityLabel={t("common.back")}
          className="h-9 w-9 rounded-full"
        >
          <ArrowLeft size={20} className="text-muted-foreground" />
        </Button>
      )}
      <View className="flex-1 min-w-0">
        {/* One control tall (`h-9`), so the title line and the buttons share a
            centre line under `items-start`, whatever the subtitle adds below. */}
        <View className="min-h-9 justify-center">
          <Text className="text-lg font-bold">{title}</Text>
        </View>
        {subtitle && (
          <Text className="text-sm text-muted-foreground">{subtitle}</Text>
        )}
      </View>
    </View>
  );
}
