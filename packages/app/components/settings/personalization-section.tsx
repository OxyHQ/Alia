import { View, TextInput as RNTextInput, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useState, useEffect } from "react";
import { useOxy } from "@oxyhq/services";
import { generateAPIUrl } from "@/lib/generate-api-url";
import {
  Globe,
  MapPin,
  Briefcase,
  User as UserIcon,
  Languages,
  Mic,
  ChevronDown,
} from "lucide-react-native";
import { PersonalityStylePicker } from "./personality-style-picker";
import { useUserData } from "@/lib/hooks/use-user-data";
import { useUserDataStore } from "@/lib/stores/user-data-store";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { useTranslation } from "@/lib/hooks/use-translation";
import { toast } from "@oxyhq/bloom/toast";
import { useTheme } from "@oxyhq/bloom/theme";
import { SettingsListGroup, SettingsListItem } from "@oxyhq/bloom/settings-list";

const LANGUAGES = [
  { value: "en-US", label: "English" },
  { value: "es-ES", label: "Español" },
  { value: "fr-FR", label: "Français" },
  { value: "de-DE", label: "Deutsch" },
  { value: "it-IT", label: "Italiano" },
  { value: "pt-BR", label: "Português" },
  { value: "zh-CN", label: "中文" },
  { value: "ja-JP", label: "日本語" },
  { value: "ko-KR", label: "한국어" },
  { value: "ru-RU", label: "Русский" },
  { value: "ar-SA", label: "العربية" },
  { value: "hi-IN", label: "हिन्दी" },
];

type FieldKey = "occupation" | "location" | "bio" | "interests";

const FIELDS: {
  key: FieldKey;
  icon: typeof Globe;
  titleKey: string;
  descriptionKey: string;
  placeholderKey: string;
  multiline?: boolean;
}[] = [
  { key: "occupation", icon: Briefcase, titleKey: "settings.occupation.title", descriptionKey: "settings.occupation.description", placeholderKey: "settings.occupation.placeholder" },
  { key: "location", icon: MapPin, titleKey: "settings.location.title", descriptionKey: "settings.location.description", placeholderKey: "settings.location.placeholder" },
  { key: "bio", icon: UserIcon, titleKey: "settings.aboutYou.title", descriptionKey: "settings.aboutYou.description", placeholderKey: "settings.aboutYou.placeholder", multiline: true },
  { key: "interests", icon: Globe, titleKey: "settings.interests.title", descriptionKey: "settings.interests.description", placeholderKey: "settings.interests.placeholder", multiline: true },
];

export function PersonalizationSection() {
  const { isAuthenticated, oxyServices } = useOxy();
  const { memory } = useUserData();
  const setMemory = useUserDataStore((state) => state.setMemory);
  const [saving, setSaving] = useState(false);
  const { t } = useTranslation();
  const { colors } = useTheme();

  const [language, setLanguage] = useState("");
  const [tone, setTone] = useState("");
  const [voice, setVoice] = useState("");
  const [occupation, setOccupation] = useState("");
  const [location, setLocation] = useState("");
  const [bio, setBio] = useState("");
  const [interests, setInterests] = useState("");

  const fieldValues: Record<FieldKey, string> = { occupation, location, bio, interests };
  const fieldSetters: Record<FieldKey, (value: string) => void> = {
    occupation: setOccupation,
    location: setLocation,
    bio: setBio,
    interests: setInterests,
  };

  useEffect(() => {
    if (memory) {
      setLanguage(memory.preferences?.language || "");
      setTone(memory.preferences?.tone || "");
      setVoice(memory.preferences?.voice || "");
      setOccupation(memory.context?.occupation || "");
      setLocation(memory.context?.location || "");
      setBio(memory.context?.bio || "");
      setInterests(memory.preferences?.interests?.join(", ") || "");
    }
  }, [memory]);

  const handleCancel = () => {
    if (memory) {
      setLanguage(memory.preferences?.language || "");
      setTone(memory.preferences?.tone || "");
      setVoice(memory.preferences?.voice || "");
      setOccupation(memory.context?.occupation || "");
      setLocation(memory.context?.location || "");
      setBio(memory.context?.bio || "");
      setInterests(memory.preferences?.interests?.join(", ") || "");
    }
  };

  const handleSave = async () => {
    if (!isAuthenticated) return;

    setSaving(true);
    try {
      const token = oxyServices.getAccessToken();
      const authHeaders: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (token) authHeaders["Authorization"] = `Bearer ${token}`;

      const prefRes = await fetch(generateAPIUrl("/memory/preferences"), {
        method: "PUT",
        headers: authHeaders,
        body: JSON.stringify({
          language,
          tone,
          voice,
          interests: interests
            .split(",")
            .map((i) => i.trim())
            .filter(Boolean),
        }),
      });

      const contextRes = await fetch(generateAPIUrl("/memory/context"), {
        method: "PUT",
        headers: authHeaders,
        body: JSON.stringify({ occupation, location, bio }),
      });

      if (prefRes.ok && contextRes.ok) {
        const updatedMemory = await contextRes.json();
        setMemory(updatedMemory);
        toast.success(t("settings.saveSuccess"));
      } else {
        toast.error(t("settings.saveFailed"));
      }
    } catch (error) {
      console.error("Error saving memory:", error);
      toast.error(t("settings.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    "border border-border rounded-lg px-3 py-2 bg-background text-foreground text-sm";

  return (
    <View className="gap-5">
      <SettingsListGroup title={t("settings.sections.personalization")}>
        <SettingsListItem
          icon={<Languages size={18} color={colors.textSecondary} />}
          title={t("settings.aliaLanguage.title")}
          description={t("settings.aliaLanguage.description")}
          rightElement={
            <DropdownMenu.Root>
              <DropdownMenu.Trigger>
                <Pressable className={`${inputClass} flex-row items-center gap-1`}>
                  <Text className="text-foreground text-sm">
                    {LANGUAGES.find(l => l.value === language)?.label || language || t("settings.aliaLanguage.selectPlaceholder")}
                  </Text>
                  <ChevronDown size={16} className="text-muted-foreground" />
                </Pressable>
              </DropdownMenu.Trigger>
              <DropdownMenu.Content>
                {LANGUAGES.map((lang) => (
                  <DropdownMenu.CheckboxItem
                    key={lang.value}
                    value={language === lang.value ? 'on' : 'off'}
                    onValueChange={() => setLanguage(lang.value)}
                  >
                    <DropdownMenu.ItemIndicator />
                    <DropdownMenu.ItemTitle>{lang.label}</DropdownMenu.ItemTitle>
                  </DropdownMenu.CheckboxItem>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          }
        />
        <SettingsListItem
          icon={<Mic size={18} color={colors.textSecondary} />}
          title={t("settings.voicePreference.title")}
          description={t("settings.voicePreference.description")}
          rightElement={
            <DropdownMenu.Root>
              <DropdownMenu.Trigger>
                <Pressable className={`${inputClass} flex-row items-center gap-1`}>
                  <Text className="text-foreground text-sm">
                    {voice === "male"
                      ? t("settings.voicePreference.male")
                      : t("settings.voicePreference.female")}
                  </Text>
                  <ChevronDown size={16} className="text-muted-foreground" />
                </Pressable>
              </DropdownMenu.Trigger>
              <DropdownMenu.Content>
                <DropdownMenu.CheckboxItem
                  key="female"
                  value={(!voice || voice === "female") ? "on" : "off"}
                  onValueChange={() => setVoice("female")}
                >
                  <DropdownMenu.ItemIndicator />
                  <DropdownMenu.ItemTitle>{t("settings.voicePreference.female")}</DropdownMenu.ItemTitle>
                </DropdownMenu.CheckboxItem>
                <DropdownMenu.CheckboxItem
                  key="male"
                  value={voice === "male" ? "on" : "off"}
                  onValueChange={() => setVoice("male")}
                >
                  <DropdownMenu.ItemIndicator />
                  <DropdownMenu.ItemTitle>{t("settings.voicePreference.male")}</DropdownMenu.ItemTitle>
                </DropdownMenu.CheckboxItem>
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          }
        />
      </SettingsListGroup>

      <PersonalityStylePicker selectedStyle={tone} onSelectStyle={setTone} />

      {FIELDS.map(({ key, icon: Icon, titleKey, descriptionKey, placeholderKey, multiline }) => (
        <View key={key} className="gap-1.5">
          <View className="flex-row items-center gap-2">
            <Icon size={18} className="text-primary" />
            <Text className="text-sm font-semibold">{t(titleKey)}</Text>
          </View>
          <Text className="text-xs text-muted-foreground">{t(descriptionKey)}</Text>
          <RNTextInput
            className={inputClass}
            placeholder={t(placeholderKey)}
            placeholderTextColor={colors.textSecondary}
            value={fieldValues[key]}
            onChangeText={fieldSetters[key]}
            multiline={multiline}
          />
        </View>
      ))}

      <View className="flex-row gap-2 mt-2">
        <Button variant="outline" className="flex-1" onPress={handleCancel} disabled={saving}>
          <Text>{t("common.cancel")}</Text>
        </Button>
        <Button className="flex-1" onPress={handleSave} disabled={saving}>
          <Text>{saving ? t("settings.saving") : t("settings.saveButton")}</Text>
        </Button>
      </View>
    </View>
  );
}
