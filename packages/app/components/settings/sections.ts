import type { Href } from "expo-router";
import type { SettingsIcon } from "@oxy.so/bloom/settings-modal";
import { RiSettings6Line } from "@oxy.so/bloom/icons/RiSettings6Line";
import { RiSchoolLine } from "@oxy.so/bloom/icons/RiSchoolLine";
import { RiBankCardLine } from "@oxy.so/bloom/icons/RiBankCardLine";
import { RiDashboardLine } from "@oxy.so/bloom/icons/RiDashboardLine";
import { RiToolsFill } from "@oxy.so/bloom/icons/RiToolsFill";
import { RiDatabase2Line } from "@oxy.so/bloom/icons/RiDatabase2Line";
import { RiShieldLine } from "@oxy.so/bloom/icons/RiShieldLine";
import { RiPaletteLine } from "@oxy.so/bloom/icons/RiPaletteLine";
import { RiLightbulbFlashLine } from "@oxy.so/bloom/icons/RiLightbulbFlashLine";
import { RiQuillPenLine } from "@oxy.so/bloom/icons/RiQuillPenLine";
import { RiSmartphoneLine } from "@oxy.so/bloom/icons/RiSmartphoneLine";
import { RiRobot2Line } from "@oxy.so/bloom/icons/RiRobot2Line";
import { RiPlugLine } from "@oxy.so/bloom/icons/RiPlugLine";
import { RiComputerLine } from "@oxy.so/bloom/icons/RiComputerLine";

export interface SettingsSection {
  id: string;
  route: Href;
  icon: SettingsIcon;
  labelKey: string;
}

/**
 * The settings navigation, grouped as Bloom's settings modal story groups it:
 * the account's own pages first (General, Profile, Billing, Usage, Tools,
 * Storage),
 * then what shapes the assistant, then connections, then this device.
 */
export const SETTINGS_GROUPS: { titleKey: string; sections: SettingsSection[] }[] = [
  {
    titleKey: "settings.title",
    sections: [
      { id: "general", route: "/(app)/settings/general", icon: RiSettings6Line, labelKey: "settings.sections.general" },
      { id: "profile", route: "/(app)/settings/profile", icon: RiSchoolLine, labelKey: "settings.sections.profile" },
      { id: "usage", route: "/(app)/settings/usage", icon: RiBankCardLine, labelKey: "settings.sections.billing" },
      { id: "limits", route: "/(app)/settings/limits", icon: RiDashboardLine, labelKey: "settings.sections.usage" },
      { id: "connectors", route: "/(app)/settings/connectors", icon: RiToolsFill, labelKey: "settings.sections.connectors" },
      { id: "storage", route: "/(app)/settings/storage", icon: RiDatabase2Line, labelKey: "settings.sections.storage" },
      { id: "security", route: "/(app)/settings/security", icon: RiShieldLine, labelKey: "settings.sections.security" },
    ],
  },
  {
    titleKey: "settings.groups.assistant",
    sections: [
      { id: "personalization", route: "/(app)/settings/personalization", icon: RiPaletteLine, labelKey: "settings.sections.personalization" },
      { id: "memory", route: "/(app)/settings/memory", icon: RiLightbulbFlashLine, labelKey: "settings.sections.memory" },
      { id: "writing-style", route: "/(app)/settings/writing-style", icon: RiQuillPenLine, labelKey: "settings.sections.writingStyle" },
    ],
  },
  {
    titleKey: "settings.groups.connections",
    sections: [
      { id: "accounts", route: "/(app)/settings/accounts", icon: RiSmartphoneLine, labelKey: "settings.sections.accounts" },
      { id: "bots", route: "/(app)/settings/bots", icon: RiRobot2Line, labelKey: "settings.sections.bots" },
      { id: "integrations", route: "/(app)/settings/integrations", icon: RiPlugLine, labelKey: "settings.sections.integrations" },
    ],
  },
  {
    titleKey: "settings.groups.device",
    sections: [
      { id: "local-models", route: "/(app)/settings/local-models", icon: RiComputerLine, labelKey: "settings.sections.localModels" },
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
