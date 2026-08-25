import type { Href } from "expo-router";
import { Palette, Brain, Smartphone, Bot, Plug, HardDrive } from "lucide-react-native";
import { CurrencyDollarIcon } from "@/components/ui/icons/currency-dollar-icon";
import { LockShieldIcon } from "@/components/ui/icons/lock-shield-icon";
import { PencilIcon } from "@/components/ui/icons/pencil-icon";
import { PluginsIcon } from "@/components/ui/icons/plugins-icon";
import { SettingsIcon } from "@/components/ui/icons/settings-icon";
import { SkillsIcon } from "@/components/ui/icons/skills-icon";
import type { IconComponent } from "@/lib/types/icon";

export interface SettingsSection {
  id: string;
  route: Href;
  icon: IconComponent;
  labelKey: string;
}

/** One source of truth for the settings nav: the menu screen and the in-panel column both read it. */
export const SETTINGS_GROUPS: { titleKey: string; sections: SettingsSection[] }[] = [
  {
    titleKey: "settings.groups.assistant",
    sections: [
      { id: "personalization", route: "/(app)/settings/personalization", icon: Palette, labelKey: "settings.sections.personalization" },
      { id: "memory", route: "/(app)/settings/memory", icon: Brain, labelKey: "settings.sections.memory" },
      { id: "writing-style", route: "/(app)/settings/writing-style", icon: PencilIcon, labelKey: "settings.sections.writingStyle" },
      { id: "skills", route: "/(app)/settings/skills", icon: SkillsIcon, labelKey: "settings.sections.skills" },
    ],
  },
  {
    titleKey: "settings.groups.connections",
    sections: [
      { id: "accounts", route: "/(app)/settings/accounts", icon: Smartphone, labelKey: "settings.sections.accounts" },
      { id: "bots", route: "/(app)/settings/bots", icon: Bot, labelKey: "settings.sections.bots" },
      { id: "connectors", route: "/(app)/settings/connectors", icon: PluginsIcon, labelKey: "settings.sections.connectors" },
      { id: "integrations", route: "/(app)/settings/integrations", icon: Plug, labelKey: "settings.sections.integrations" },
    ],
  },
  {
    titleKey: "settings.groups.app",
    sections: [
      { id: "general", route: "/(app)/settings/general", icon: SettingsIcon, labelKey: "settings.sections.general" },
      { id: "local-models", route: "/(app)/settings/local-models", icon: HardDrive, labelKey: "settings.sections.localModels" },
      { id: "usage", route: "/(app)/settings/usage", icon: CurrencyDollarIcon, labelKey: "settings.sections.billing" },
      { id: "security", route: "/(app)/settings/security", icon: LockShieldIcon, labelKey: "settings.sections.security" },
    ],
  },
];

export const SETTINGS_SECTIONS = SETTINGS_GROUPS.flatMap((group) => group.sections);

/** Path of the section the two-pane layout opens when none is selected yet. */
export const FIRST_SETTINGS_SECTION = SETTINGS_SECTIONS[0].route;

/** Which section a pathname belongs to, or undefined at the /settings root. */
export function activeSettingsSection(pathname: string): string | undefined {
  return SETTINGS_SECTIONS.find((section) =>
    pathname.startsWith(String(section.route).replace("/(app)", "")),
  )?.id;
}
