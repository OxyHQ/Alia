import React from "react";
import { View, Pressable } from "react-native";
import { Image } from "expo-image";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { BaseSidebar } from "@/components/base-sidebar";
import { useRouter, usePathname } from "expo-router";
import { useTranslation } from "@/hooks/useTranslation";
import {
  User,
  Settings2,
  CreditCard,
  Palette,
  Brain,
  Plug,
  MessageSquarePlus,
  ArrowLeft,
  type LucideIcon,
} from "lucide-react-native";

interface SettingsSection {
  id: string;
  route: string;
  icon: LucideIcon;
  labelKey: string;
}

const SECTIONS: SettingsSection[] = [
  { id: "account", route: "/(app)/settings", icon: User, labelKey: "settings.sections.account" },
  { id: "general", route: "/(app)/settings/general", icon: Settings2, labelKey: "settings.sections.general" },
  { id: "usage", route: "/(app)/settings/usage", icon: CreditCard, labelKey: "settings.sections.billing" },
  { id: "personalization", route: "/(app)/settings/personalization", icon: Palette, labelKey: "settings.sections.personalization" },
  { id: "memory", route: "/(app)/settings/memory", icon: Brain, labelKey: "settings.sections.memory" },
  { id: "connectors", route: "/(app)/settings/connectors", icon: Plug, labelKey: "settings.sections.connectors" },
  { id: "feedback", route: "/(app)/settings/feedback", icon: MessageSquarePlus, labelKey: "settings.sections.feedback" },
];

export const SettingsSidebar = React.memo(function SettingsSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useTranslation();

  const activeId = React.useMemo(() => {
    // Gateway sub-pages map to connectors
    if (pathname.includes("/whatsapp") || pathname.includes("/telegram-gateway") || pathname.includes("/signal-gateway")) {
      return "connectors";
    }
    // Match specific section routes
    if (pathname.includes("/settings/general")) return "general";
    if (pathname.includes("/settings/usage")) return "usage";
    if (pathname.includes("/settings/personalization")) return "personalization";
    if (pathname.includes("/settings/memory")) return "memory";
    if (pathname.includes("/settings/connectors")) return "connectors";
    if (pathname.includes("/settings/feedback")) return "feedback";
    // Default: account (settings/index)
    return "account";
  }, [pathname]);

  const handleSelect = (section: SettingsSection) => {
    router.push(section.route as any);
  };

  const handleBack = () => {
    router.replace("/(app)");
  };

  const header = (
    <Pressable onPress={() => router.replace("/(app)")} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      <Image
        source={require("@/assets/images/logo.png")}
        style={{ width: "100%", height: 48 }}
        contentFit="contain"
      />
    </Pressable>
  );

  const topSection = (
    <Button
      onPress={handleBack}
      variant="ghost"
      className="h-9 md:h-8 flex-row items-center justify-start gap-2 rounded-full px-3 md:px-2 w-full"
    >
      <ArrowLeft size={16} className="text-muted-foreground" />
      <Text className="text-sm md:text-xs font-medium">{t("common.back")}</Text>
    </Button>
  );

  const navigation = (
    <View className="gap-0.5">
      <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase px-2 mb-1">
        {t("settings.title")}
      </Text>
      {SECTIONS.map((section) => {
        const Icon = section.icon;
        const isActive = activeId === section.id;

        return (
          <Pressable
            key={section.id}
            onPress={() => handleSelect(section)}
            className={`flex-row items-center rounded-full px-3 md:px-2 h-9 md:h-8 ${
              isActive ? "bg-muted" : "active:bg-muted/50"
            }`}
          >
            <Icon
              size={16}
              className={isActive ? "text-foreground" : "text-muted-foreground"}
            />
            <Text
              className={`ml-2 text-sm md:text-xs flex-1 ${
                isActive ? "font-medium text-foreground" : "text-muted-foreground"
              }`}
            >
              {t(section.labelKey)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );

  const footer = <View />;

  return (
    <BaseSidebar
      header={header}
      topSection={topSection}
      navigation={navigation}
      footer={footer}
      backgroundColor="bg-background"
    />
  );
});
