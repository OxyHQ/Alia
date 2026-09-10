import React from "react";
import { useNavigation } from "expo-router";
import type { DrawerNavigationProp } from "expo-router/drawer";
import { Button } from "@/components/ui/button";
import { MenuIcon } from "@/components/ui/icons/menu-icon";
import { useColorScheme } from "@/lib/useColorScheme";
import { useTranslation } from "@/lib/hooks/use-translation";
import { cn } from "@/lib/utils";

/**
 * The one control that opens the navigation drawer at narrow widths.
 *
 * Below `md` the drawer is a `front` overlay with nothing on screen to open
 * it: a top-level page such as Library rendered its own header with no
 * opener at all, so at 390px the only way back to chat was the swipe gesture
 * nobody is told about (#532). The chat header and the settings header each
 * carried their own copy of this button; this is the shared one, so every
 * top-level page shows the same labelled control in the same place.
 *
 * Hidden at `md` and above, where the drawer is permanent and the sidebar's
 * own collapse control takes over.
 */
export function DrawerToggle({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const navigation = useNavigation<DrawerNavigationProp<ReactNavigation.RootParamList>>();

  return (
    <Button
      variant="ghost"
      size="icon"
      onPress={() => navigation.toggleDrawer()}
      accessibilityRole="button"
      accessibilityLabel={t("nav.openNavigation")}
      className={cn("h-9 w-9 rounded-full md:hidden", className)}
    >
      <MenuIcon size={20} color={colors.mutedForeground} />
    </Button>
  );
}
