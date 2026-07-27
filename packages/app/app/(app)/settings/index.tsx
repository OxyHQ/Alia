import { View, ScrollView } from "react-native";
import { useRouter, type Href } from "expo-router";
import { SettingsListGroup, SettingsListItem } from "@oxyhq/bloom/settings-list";
import {
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
  Shield,
  type LucideIcon,
} from "lucide-react-native";
import { useTranslation } from "@/lib/hooks/use-translation";
import { SettingsHeader } from "@/components/settings/settings-header";
import { useColorScheme } from "@/lib/useColorScheme";

interface SettingsEntry {
  id: string;
  route: Href;
  icon: LucideIcon;
  labelKey: string;
}

/** On desktop these routes also sit in the sidebar; on mobile this is the entry point. */
const GROUPS: { titleKey: string; entries: SettingsEntry[] }[] = [
  {
    titleKey: "settings.groups.assistant",
    entries: [
      { id: "personalization", route: "/(app)/settings/personalization", icon: Palette, labelKey: "settings.sections.personalization" },
      { id: "memory", route: "/(app)/settings/memory", icon: Brain, labelKey: "settings.sections.memory" },
      { id: "writing-style", route: "/(app)/settings/writing-style", icon: PenTool, labelKey: "settings.sections.writingStyle" },
      { id: "skills", route: "/(app)/settings/skills", icon: Zap, labelKey: "settings.sections.skills" },
    ],
  },
  {
    titleKey: "settings.groups.connections",
    entries: [
      { id: "accounts", route: "/(app)/settings/accounts", icon: Smartphone, labelKey: "settings.sections.accounts" },
      { id: "bots", route: "/(app)/settings/bots", icon: Bot, labelKey: "settings.sections.bots" },
      { id: "connectors", route: "/(app)/settings/connectors", icon: Blocks, labelKey: "settings.sections.connectors" },
      { id: "integrations", route: "/(app)/settings/integrations", icon: Plug, labelKey: "settings.sections.integrations" },
    ],
  },
  {
    titleKey: "settings.groups.app",
    entries: [
      { id: "general", route: "/(app)/settings/general", icon: Settings2, labelKey: "settings.sections.general" },
      { id: "usage", route: "/(app)/settings/usage", icon: CreditCard, labelKey: "settings.sections.billing" },
      { id: "security", route: "/(app)/settings/security", icon: Shield, labelKey: "settings.sections.security" },
    ],
  },
];

export default function SettingsIndexScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors } = useColorScheme();

  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title={t("settings.title")} />
      <ScrollView className="flex-1" contentContainerClassName="p-5 max-w-2xl">
        {GROUPS.map((group) => (
          <SettingsListGroup key={group.titleKey} title={t(group.titleKey)}>
            {group.entries.map(({ id, route, icon: Icon, labelKey }) => (
              <SettingsListItem
                key={id}
                icon={<Icon size={18} color={colors.mutedForeground} />}
                title={t(labelKey)}
                onPress={() => router.push(route)}
              />
            ))}
          </SettingsListGroup>
        ))}
      </ScrollView>
    </View>
  );
}
