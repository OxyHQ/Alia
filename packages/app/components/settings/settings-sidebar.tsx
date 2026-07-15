import React from "react";
import { View, Pressable } from "react-native";
import { AliaLogo } from "@/components/ui/alia-logo";
import { AliaMark } from "@alia.onl/sdk";
import { Text } from "@/components/ui/text";
import { BaseSidebar } from "@/components/base-sidebar";
import {
  SidebarRow,
  GhostIconButton,
  useRailTooltip,
  useSidebarCollapse,
} from "@/components/sidebar/primitives";
import { useRouter, usePathname, type Href } from "expo-router";
import { useTranslation } from "@/lib/hooks/use-translation";
import {
  User,
  Settings2,
  CreditCard,
  Palette,
  Brain,
  PenTool,
  Smartphone,
  Bot,
  Blocks,
  Plug,
  Zap,
  MessageSquarePlus,
  Shield,
  ArrowLeft,
  ChevronsLeft,
  ChevronsRight,
  type LucideIcon,
} from "lucide-react-native";

interface SettingsSection {
  id: string;
  route: Href;
  icon: LucideIcon;
  labelKey: string;
}

const SECTIONS: SettingsSection[] = [
  { id: "account", route: "/(app)/settings", icon: User, labelKey: "settings.sections.account" },
  { id: "general", route: "/(app)/settings/general", icon: Settings2, labelKey: "settings.sections.general" },
  { id: "usage", route: "/(app)/settings/usage", icon: CreditCard, labelKey: "settings.sections.billing" },
  { id: "personalization", route: "/(app)/settings/personalization", icon: Palette, labelKey: "settings.sections.personalization" },
  { id: "memory", route: "/(app)/settings/memory", icon: Brain, labelKey: "settings.sections.memory" },
  { id: "writing-style", route: "/(app)/settings/writing-style", icon: PenTool, labelKey: "settings.sections.writingStyle" },
  { id: "accounts", route: "/(app)/settings/accounts", icon: Smartphone, labelKey: "settings.sections.accounts" },
  { id: "bots", route: "/(app)/settings/bots", icon: Bot, labelKey: "settings.sections.bots" },
  { id: "mcp", route: "/(app)/settings/mcp", icon: Blocks, labelKey: "settings.sections.mcp" },
  { id: "integrations", route: "/(app)/settings/integrations", icon: Plug, labelKey: "settings.sections.integrations" },
  { id: "skills", route: "/(app)/settings/skills", icon: Zap, labelKey: "settings.sections.skills" },
  { id: "security", route: "/(app)/settings/security", icon: Shield, labelKey: "settings.sections.security" },
  { id: "feedback", route: "/(app)/settings/feedback", icon: MessageSquarePlus, labelKey: "settings.sections.feedback" },
];

export const SettingsSidebar = React.memo(function SettingsSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useTranslation();
  const { collapsed, collapse, expand } = useSidebarCollapse();
  const expandTooltip = useRailTooltip(t("sidebar.expand"));

  // Longest-prefix match against the section routes (group segment stripped);
  // "account" lives at the /settings root, so it's the fallback.
  const activeId = React.useMemo(() => {
    const match = SECTIONS.find(
      (section) =>
        section.id !== "account" &&
        pathname.startsWith(String(section.route).replace("/(app)", "")),
    );
    return match?.id ?? "account";
  }, [pathname]);

  const handleBack = React.useCallback(() => {
    router.replace("/(app)");
  }, [router]);

  const header = (
    <View className={collapsed ? "flex-row items-center justify-center" : "flex-row items-center"}>
      {collapsed ? (
        <View className="p-1.5 mx-0.5 rounded-xl hover:bg-muted active:bg-muted">
          <AliaMark size={24} onPress={handleBack} accessibilityLabel="Home" spinOnMount />
        </View>
      ) : (
        <Pressable
          accessibilityLabel="Home"
          accessibilityRole="button"
          onPress={handleBack}
          className="p-1.5 mx-0.5 rounded-xl hover:bg-muted active:bg-muted"
        >
          <AliaLogo height={36} />
        </Pressable>
      )}
      {!collapsed && (
        <View className="ml-auto">
          <GhostIconButton
            icon={ChevronsLeft}
            label={t("sidebar.collapse")}
            onPress={collapse}
          />
        </View>
      )}
    </View>
  );

  const topSection = (
    <View className="gap-px">
      <SidebarRow
        icon={ArrowLeft}
        label={t("common.back")}
        onPress={handleBack}
        iconOnly={collapsed}
      />
    </View>
  );

  const navigation = (
    <>
      {!collapsed && (
        <Text className="text-xs font-semibold text-foreground select-none px-2 pt-2 pb-1">
          {t("settings.title")}
        </Text>
      )}
      {SECTIONS.map((section) => (
        <SidebarRow
          key={section.id}
          icon={section.icon}
          label={t(section.labelKey)}
          onPress={() => router.push(section.route)}
          iconOnly={collapsed}
          active={activeId === section.id}
        />
      ))}
    </>
  );

  const footer = collapsed ? (
    <View className="gap-2 items-center">
      <GhostIconButton
        icon={ChevronsRight}
        label={t("sidebar.expand")}
        onPress={expand}
        anchorProps={expandTooltip.anchorProps}
      />
      {expandTooltip.tooltip}
    </View>
  ) : (
    <View />
  );

  return (
    <BaseSidebar
      header={header}
      topSection={topSection}
      navigation={navigation}
      footer={footer}
      backgroundColor="bg-background"
      collapsed={collapsed}
    />
  );
});
