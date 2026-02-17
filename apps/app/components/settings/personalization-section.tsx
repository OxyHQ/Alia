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
  MessageSquare,
  Mic,
  ChevronDown,
} from "lucide-react-native";
import { useUserData } from "@/hooks/useUserData";
import { useUserDataStore } from "@/lib/stores/user-data-store";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { useTranslation } from "@/hooks/useTranslation";
import { toast } from "@/components/sonner";

const LANGUAGES = [
  { value: "English", label: "English" },
  { value: "Spanish", label: "Español" },
  { value: "French", label: "Français" },
  { value: "German", label: "Deutsch" },
  { value: "Italian", label: "Italiano" },
  { value: "Portuguese", label: "Português" },
  { value: "Chinese", label: "中文" },
  { value: "Japanese", label: "日本語" },
  { value: "Korean", label: "한국어" },
  { value: "Russian", label: "Русский" },
  { value: "Arabic", label: "العربية" },
  { value: "Hindi", label: "हिन्दी" },
];

export function PersonalizationSection() {
  const { isAuthenticated, oxyServices } = useOxy();
  const { memory } = useUserData();
  const setMemory = useUserDataStore((state) => state.setMemory);
  const [saving, setSaving] = useState(false);
  const { t } = useTranslation();

  const [language, setLanguage] = useState("");
  const [tone, setTone] = useState("");
  const [voice, setVoice] = useState("");
  const [occupation, setOccupation] = useState("");
  const [location, setLocation] = useState("");
  const [bio, setBio] = useState("");
  const [interests, setInterests] = useState("");

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
      {/* Alia's Language */}
      <View className="gap-1.5">
        <View className="flex-row items-center gap-2">
          <Languages size={18} className="text-primary" />
          <Text className="text-sm font-semibold">{t("settings.aliaLanguage.title")}</Text>
        </View>
        <Text className="text-xs text-muted-foreground">
          {t("settings.aliaLanguage.description")}
        </Text>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <Pressable className={`${inputClass} flex-row items-center justify-between`}>
              <Text className="text-foreground text-sm">
                {language || t("settings.aliaLanguage.selectPlaceholder")}
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
      </View>

      {/* Tone */}
      <View className="gap-1.5">
        <View className="flex-row items-center gap-2">
          <MessageSquare size={18} className="text-primary" />
          <Text className="text-sm font-semibold">{t("settings.responseTone.title")}</Text>
        </View>
        <Text className="text-xs text-muted-foreground">
          {t("settings.responseTone.description")}
        </Text>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <Pressable className={`${inputClass} flex-row items-center justify-between`}>
              <Text className="text-foreground text-sm">
                {tone
                  ? t(`settings.responseTone.${tone}`)
                  : t("settings.responseTone.selectPlaceholder")}
              </Text>
              <ChevronDown size={16} className="text-muted-foreground" />
            </Pressable>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content>
            {(["casual", "professional", "friendly", "concise"] as const).map((opt) => (
              <DropdownMenu.CheckboxItem
                key={opt}
                value={tone === opt ? "on" : "off"}
                onValueChange={() => setTone(opt)}
              >
                <DropdownMenu.ItemIndicator />
                <DropdownMenu.ItemTitle>{t(`settings.responseTone.${opt}`)}</DropdownMenu.ItemTitle>
              </DropdownMenu.CheckboxItem>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </View>

      {/* Voice Preference */}
      <View className="gap-1.5">
        <View className="flex-row items-center gap-2">
          <Mic size={18} className="text-primary" />
          <Text className="text-sm font-semibold">{t("settings.voicePreference.title")}</Text>
        </View>
        <Text className="text-xs text-muted-foreground">
          {t("settings.voicePreference.description")}
        </Text>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <Pressable className={`${inputClass} flex-row items-center justify-between`}>
              <Text className="text-foreground text-sm">
                {voice === "male"
                  ? t("settings.voicePreference.male")
                  : voice === "female"
                    ? t("settings.voicePreference.female")
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
      </View>

      {/* Occupation */}
      <View className="gap-1.5">
        <View className="flex-row items-center gap-2">
          <Briefcase size={18} className="text-primary" />
          <Text className="text-sm font-semibold">{t("settings.occupation.title")}</Text>
        </View>
        <Text className="text-xs text-muted-foreground">
          {t("settings.occupation.description")}
        </Text>
        <RNTextInput
          className={inputClass}
          placeholder={t("settings.occupation.placeholder")}
          placeholderTextColor="#9ca3af"
          value={occupation}
          onChangeText={setOccupation}
        />
      </View>

      {/* Location */}
      <View className="gap-1.5">
        <View className="flex-row items-center gap-2">
          <MapPin size={18} className="text-primary" />
          <Text className="text-sm font-semibold">{t("settings.location.title")}</Text>
        </View>
        <Text className="text-xs text-muted-foreground">
          {t("settings.location.description")}
        </Text>
        <RNTextInput
          className={inputClass}
          placeholder={t("settings.location.placeholder")}
          placeholderTextColor="#9ca3af"
          value={location}
          onChangeText={setLocation}
        />
      </View>

      {/* Bio */}
      <View className="gap-1.5">
        <View className="flex-row items-center gap-2">
          <UserIcon size={18} className="text-primary" />
          <Text className="text-sm font-semibold">{t("settings.aboutYou.title")}</Text>
        </View>
        <Text className="text-xs text-muted-foreground">
          {t("settings.aboutYou.description")}
        </Text>
        <RNTextInput
          className={inputClass}
          placeholder={t("settings.aboutYou.placeholder")}
          placeholderTextColor="#9ca3af"
          value={bio}
          onChangeText={setBio}
          multiline
          numberOfLines={3}
        />
      </View>

      {/* Interests */}
      <View className="gap-1.5">
        <View className="flex-row items-center gap-2">
          <Globe size={18} className="text-primary" />
          <Text className="text-sm font-semibold">{t("settings.interests.title")}</Text>
        </View>
        <Text className="text-xs text-muted-foreground">
          {t("settings.interests.description")}
        </Text>
        <RNTextInput
          className={inputClass}
          placeholder={t("settings.interests.placeholder")}
          placeholderTextColor="#9ca3af"
          value={interests}
          onChangeText={setInterests}
          multiline
        />
      </View>

      {/* Save / Cancel */}
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
