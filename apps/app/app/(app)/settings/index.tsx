import { View, ScrollView, TextInput as RNTextInput, Pressable, Linking } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useState, useEffect } from "react";
import { useOxy } from "@oxyhq/services";
import { useRouter } from "expo-router";
import { generateAPIUrl } from "@/lib/generate-api-url";
import { Globe, MapPin, Briefcase, User as UserIcon, Languages, MessageSquare, ChevronDown, Check, ChevronRight, Brain, User, Moon, Sun, Monitor, MessageSquarePlus, Send } from "lucide-react-native";
import { useUserData } from "@/hooks/useUserData";
import { useTelegramStatus } from "@/hooks/useTelegramStatus";
import { useUserDataStore } from "@/lib/stores/user-data-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useColorScheme } from "@/lib/useColorScheme";
import type { ThemeMode } from "@/lib/stores/theme-store";
import { useTranslation } from "@/hooks/useTranslation";
import { LanguageSelector } from "@/components/language-selector";
import { toast } from "@/components/sonner";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";

interface UserMemory {
  preferences: {
    language?: string;
    tone?: string;
    responseLength?: 'short' | 'medium' | 'long';
    interests?: string[];
  };
  context: {
    occupation?: string;
    location?: string;
    bio?: string;
  };
}

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

export default function SettingsScreen() {
  const router = useRouter();
  const { user, isAuthenticated, activeSessionId } = useOxy();
  const { memory, loading } = useUserData();
  const setMemory = useUserDataStore((state) => state.setMemory);
  const [saving, setSaving] = useState(false);
  const { mode, setColorScheme } = useColorScheme();
  const { t } = useTranslation();
  const { status: telegramStatus, loading: telegramLoading } = useTelegramStatus();

  // Form state
  const [language, setLanguage] = useState("");
  const [tone, setTone] = useState("");
  const [occupation, setOccupation] = useState("");
  const [location, setLocation] = useState("");
  const [bio, setBio] = useState("");
  const [interests, setInterests] = useState("");

  // Dialog state
  const [showUnlinkDialog, setShowUnlinkDialog] = useState(false);
  const [unlinking, setUnlinking] = useState(false);

  // Redirect if not authenticated
  useEffect(() => {
    if (!isAuthenticated) {
      router.replace("/login");
    }
  }, [isAuthenticated]);

  // Load form data from cached memory
  useEffect(() => {
    if (memory) {
      setLanguage(memory.preferences?.language || "");
      setTone(memory.preferences?.tone || "");
      setOccupation(memory.context?.occupation || "");
      setLocation(memory.context?.location || "");
      setBio(memory.context?.bio || "");
      setInterests(memory.preferences?.interests?.join(", ") || "");
    }
  }, [memory]);

  const handleSave = async () => {
    if (!activeSessionId) return;

    setSaving(true);
    try {
      // Save preferences
      const preferencesUrl = generateAPIUrl('/memory/preferences');
      const prefRes = await fetch(preferencesUrl, {
        method: 'PUT',
        headers: {
          'x-session-id': activeSessionId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          language,
          tone,
          interests: interests.split(",").map(i => i.trim()).filter(Boolean),
        }),
      });

      // Save context
      const contextUrl = generateAPIUrl('/memory/context');
      const contextRes = await fetch(contextUrl, {
        method: 'PUT',
        headers: {
          'x-session-id': activeSessionId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          occupation,
          location,
          bio,
        }),
      });

      if (contextRes.ok) {
        const updatedMemory = await contextRes.json();
        // Update cache
        setMemory(updatedMemory);
        toast.success(t('settings.saveSuccess'));
        router.back();
      }
    } catch (error) {
      console.error("Error saving memory:", error);
      toast.error(t('settings.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <Text>{t('common.loading')}</Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <View className="border-b border-border p-4">
        <Text className="text-2xl font-bold">{t('settings.title')}</Text>
        <Text className="text-sm text-muted-foreground mt-1">
          {t('settings.subtitle')}
        </Text>
      </View>

      <ScrollView className="flex-1 p-4">
        <View className="max-w-2xl mx-auto w-full gap-6">
          {/* Quick Links */}
          <View className="gap-3">
            <Text className="text-sm font-semibold text-muted-foreground">{t('settings.quickAccess')}</Text>

            <Pressable
              onPress={() => router.push("/(app)/settings/memory")}
              className="border border-border rounded-lg p-4 bg-surface flex-row items-center justify-between active:bg-muted"
            >
              <View className="flex-row items-center gap-3">
                <View className="bg-primary/10 p-2 rounded-lg">
                  <Brain size={24} className="text-primary" />
                </View>
                <View>
                  <Text className="text-base font-semibold">{t('settings.memoryManagement.title')}</Text>
                  <Text className="text-sm text-muted-foreground">
                    {t('settings.memoryManagement.description')}
                  </Text>
                </View>
              </View>
              <ChevronRight size={20} className="text-muted-foreground" />
            </Pressable>

            <Pressable
              onPress={() => router.push("/(app)/settings/account")}
              className="border border-border rounded-lg p-4 bg-surface flex-row items-center justify-between active:bg-muted"
            >
              <View className="flex-row items-center gap-3">
                <View className="bg-primary/10 p-2 rounded-lg">
                  <User size={24} className="text-primary" />
                </View>
                <View>
                  <Text className="text-base font-semibold">{t('settings.account.title')}</Text>
                  <Text className="text-sm text-muted-foreground">
                    {t('settings.account.description')}
                  </Text>
                </View>
              </View>
              <ChevronRight size={20} className="text-muted-foreground" />
            </Pressable>

            <Pressable
              onPress={() => router.push("/(app)/settings/feedback")}
              className="border border-border rounded-lg p-4 bg-surface flex-row items-center justify-between active:bg-muted"
            >
              <View className="flex-row items-center gap-3">
                <View className="bg-primary/10 p-2 rounded-lg">
                  <MessageSquarePlus size={24} className="text-primary" />
                </View>
                <View>
                  <Text className="text-base font-semibold">Send Feedback</Text>
                  <Text className="text-sm text-muted-foreground">
                    Report bugs or suggest features
                  </Text>
                </View>
              </View>
              <ChevronRight size={20} className="text-muted-foreground" />
            </Pressable>

            <Pressable
              onPress={async () => {
                if (telegramStatus?.linked) {
                  setShowUnlinkDialog(true);
                  return;
                }

                // Open Telegram bot for linking
                const botUsername = process.env.EXPO_PUBLIC_TELEGRAM_BOT_USERNAME || 'alia_onlbot';
                const linkUrl = `https://t.me/${botUsername}?start=link`;

                try {
                  const canOpen = await Linking.canOpenURL(linkUrl);
                  if (canOpen) {
                    await Linking.openURL(linkUrl);
                  } else {
                    toast.error("Cannot open Telegram");
                  }
                } catch (err) {
                  console.error('Failed to open Telegram:', err);
                  toast.error("Failed to open Telegram");
                }
              }}
              className="border border-border rounded-lg p-4 bg-surface flex-row items-center justify-between active:bg-muted"
            >
              <View className="flex-row items-center gap-3">
                <View className="bg-primary/10 p-2 rounded-lg">
                  <Send size={24} className="text-primary" />
                </View>
                <View className="flex-1">
                  <Text className="text-base font-semibold">
                    {telegramLoading
                      ? "Telegram"
                      : telegramStatus?.linked
                        ? "Telegram Linked"
                        : "Link Telegram"
                    }
                  </Text>
                  <Text className="text-sm text-muted-foreground">
                    {telegramLoading
                      ? "Checking status..."
                      : telegramStatus?.linked
                        ? `Connected${telegramStatus.telegramUsername ? ` as @${telegramStatus.telegramUsername}` : ''}`
                        : "Connect your Telegram account"
                    }
                  </Text>
                </View>
              </View>
              {telegramStatus?.linked ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-3"
                  onPress={(e) => {
                    e.stopPropagation();
                    setShowUnlinkDialog(true);
                  }}
                >
                  <Text className="text-destructive text-sm">Unlink</Text>
                </Button>
              ) : (
                <ChevronRight size={20} className="text-muted-foreground" />
              )}
            </Pressable>
          </View>

          <View className="border-t border-border" />

          {/* Preferences Section */}
          <Text className="text-sm font-semibold text-muted-foreground">{t('settings.preferences')}</Text>

          {/* App Language Selector */}
          <LanguageSelector />

          {/* Theme Preference */}
          <View className="gap-4">
            <Text className="text-2xl font-bold">{t('settings.appearance.title')}</Text>

            <View className="gap-3">
              <Text className="text-base font-medium text-foreground">Color mode</Text>

              <View className="flex-row gap-3">
                {/* Light Mode Card */}
                <Pressable
                  onPress={() => setColorScheme('light')}
                  className="flex-1"
                >
                  <View className={`rounded-2xl p-4 ${mode === 'light' ? 'border-2 border-primary' : 'border border-border'}`}>
                    {/* Preview Card */}
                    <View className="bg-white rounded-xl p-3 mb-3 aspect-[4/3]">
                      <View className="flex-row gap-1 mb-2">
                        <View className="w-8 h-1 bg-gray-300 rounded" />
                        <View className="w-12 h-1 bg-gray-300 rounded" />
                      </View>
                      <View className="flex-row gap-1 mb-2">
                        <View className="w-10 h-1 bg-gray-300 rounded" />
                        <View className="w-14 h-1 bg-gray-300 rounded" />
                      </View>
                      <View className="flex-1 bg-gray-50 rounded-lg mt-2 items-end justify-end p-2">
                        <View className="w-3 h-3 rounded-full bg-primary" />
                      </View>
                    </View>
                    <Text className="text-center font-medium text-foreground">Light</Text>
                  </View>
                </Pressable>

                {/* Auto Mode Card */}
                <Pressable
                  onPress={() => setColorScheme('system')}
                  className="flex-1"
                >
                  <View className={`rounded-2xl p-4 ${mode === 'system' ? 'border-2 border-primary' : 'border border-border'}`}>
                    {/* Preview Card - Half Light / Half Dark */}
                    <View className="rounded-xl overflow-hidden mb-3 aspect-[4/3]">
                      <View className="flex-row flex-1">
                        {/* Light Half */}
                        <View className="flex-1 bg-white p-3">
                          <View className="flex-row gap-1 mb-2">
                            <View className="w-6 h-1 bg-gray-300 rounded" />
                            <View className="w-8 h-1 bg-gray-300 rounded" />
                          </View>
                          <View className="flex-row gap-1">
                            <View className="w-7 h-1 bg-gray-300 rounded" />
                            <View className="w-9 h-1 bg-gray-300 rounded" />
                          </View>
                        </View>
                        {/* Dark Half */}
                        <View className="flex-1 bg-[#1a1a1a] p-3 items-end">
                          <View className="flex-row gap-1 mb-2">
                            <View className="w-6 h-1 bg-gray-600 rounded" />
                            <View className="w-8 h-1 bg-gray-600 rounded" />
                          </View>
                          <View className="flex-row gap-1">
                            <View className="w-7 h-1 bg-gray-600 rounded" />
                            <View className="w-9 h-1 bg-gray-600 rounded" />
                          </View>
                        </View>
                      </View>
                      <View className="absolute right-2 bottom-2">
                        <View className="w-3 h-3 rounded-full bg-primary" />
                      </View>
                    </View>
                    <Text className="text-center font-medium text-foreground">Auto</Text>
                  </View>
                </Pressable>

                {/* Dark Mode Card */}
                <Pressable
                  onPress={() => setColorScheme('dark')}
                  className="flex-1"
                >
                  <View className={`rounded-2xl p-4 ${mode === 'dark' ? 'border-2 border-primary' : 'border border-border'}`}>
                    {/* Preview Card */}
                    <View className="bg-[#1a1a1a] rounded-xl p-3 mb-3 aspect-[4/3]">
                      <View className="flex-row gap-1 mb-2">
                        <View className="w-8 h-1 bg-gray-600 rounded" />
                        <View className="w-12 h-1 bg-gray-600 rounded" />
                      </View>
                      <View className="flex-row gap-1 mb-2">
                        <View className="w-10 h-1 bg-gray-600 rounded" />
                        <View className="w-14 h-1 bg-gray-600 rounded" />
                      </View>
                      <View className="flex-1 bg-[#2a2a2a] rounded-lg mt-2 items-end justify-end p-2">
                        <View className="w-3 h-3 rounded-full bg-primary" />
                      </View>
                    </View>
                    <Text className="text-center font-medium text-foreground">Dark</Text>
                  </View>
                </Pressable>
              </View>
            </View>
          </View>

          {/* Alia's Language Preference */}
          <View className="gap-2">
            <View className="flex-row items-center gap-2">
              <Languages size={20} className="text-primary" />
              <Text className="text-base font-semibold">{t('settings.aliaLanguage.title')}</Text>
            </View>
            <Text className="text-sm text-muted-foreground">
              {t('settings.aliaLanguage.description')}
            </Text>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Pressable className="border border-border rounded-lg px-4 py-3 bg-background flex-row items-center justify-between">
                  <Text className="text-foreground">
                    {language || t('settings.aliaLanguage.selectPlaceholder')}
                  </Text>
                  <ChevronDown size={20} className="text-muted-foreground" />
                </Pressable>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-64">
                {LANGUAGES.map((lang) => (
                  <DropdownMenuItem
                    key={lang.value}
                    onPress={() => setLanguage(lang.value)}
                  >
                    <View className="flex-row items-center justify-between flex-1">
                      <Text>{lang.label}</Text>
                      {language === lang.value && (
                        <Check size={16} className="text-primary" />
                      )}
                    </View>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </View>

          {/* Tone */}
          <View className="gap-2">
            <View className="flex-row items-center gap-2">
              <MessageSquare size={20} className="text-primary" />
              <Text className="text-base font-semibold">{t('settings.responseTone.title')}</Text>
            </View>
            <Text className="text-sm text-muted-foreground">
              {t('settings.responseTone.description')}
            </Text>
            <RNTextInput
              className="border border-border rounded-lg px-4 py-3 bg-background text-foreground"
              placeholder={t('settings.responseTone.placeholder')}
              value={tone}
              onChangeText={setTone}
            />
          </View>

          {/* Occupation */}
          <View className="gap-2">
            <View className="flex-row items-center gap-2">
              <Briefcase size={20} className="text-primary" />
              <Text className="text-base font-semibold">{t('settings.occupation.title')}</Text>
            </View>
            <Text className="text-sm text-muted-foreground">
              {t('settings.occupation.description')}
            </Text>
            <RNTextInput
              className="border border-border rounded-lg px-4 py-3 bg-background text-foreground"
              placeholder={t('settings.occupation.placeholder')}
              value={occupation}
              onChangeText={setOccupation}
            />
          </View>

          {/* Location */}
          <View className="gap-2">
            <View className="flex-row items-center gap-2">
              <MapPin size={20} className="text-primary" />
              <Text className="text-base font-semibold">{t('settings.location.title')}</Text>
            </View>
            <Text className="text-sm text-muted-foreground">
              {t('settings.location.description')}
            </Text>
            <RNTextInput
              className="border border-border rounded-lg px-4 py-3 bg-background text-foreground"
              placeholder={t('settings.location.placeholder')}
              value={location}
              onChangeText={setLocation}
            />
          </View>

          {/* Bio */}
          <View className="gap-2">
            <View className="flex-row items-center gap-2">
              <UserIcon size={20} className="text-primary" />
              <Text className="text-base font-semibold">{t('settings.aboutYou.title')}</Text>
            </View>
            <Text className="text-sm text-muted-foreground">
              {t('settings.aboutYou.description')}
            </Text>
            <RNTextInput
              className="border border-border rounded-lg px-4 py-3 bg-background text-foreground"
              placeholder={t('settings.aboutYou.placeholder')}
              value={bio}
              onChangeText={setBio}
              multiline
              numberOfLines={3}
            />
          </View>

          {/* Interests */}
          <View className="gap-2">
            <View className="flex-row items-center gap-2">
              <Globe size={20} className="text-primary" />
              <Text className="text-base font-semibold">{t('settings.interests.title')}</Text>
            </View>
            <Text className="text-sm text-muted-foreground">
              {t('settings.interests.description')}
            </Text>
            <RNTextInput
              className="border border-border rounded-lg px-4 py-3 bg-background text-foreground"
              placeholder={t('settings.interests.placeholder')}
              value={interests}
              onChangeText={setInterests}
              multiline
            />
          </View>

          {/* Save Button */}
          <View className="flex-row gap-2 mt-4 mb-8">
            <Button
              variant="outline"
              className="flex-1"
              onPress={() => router.back()}
              disabled={saving}
            >
              <Text>{t('common.cancel')}</Text>
            </Button>
            <Button
              className="flex-1"
              onPress={handleSave}
              disabled={saving}
            >
              <Text>{saving ? t('settings.saving') : t('settings.saveButton')}</Text>
            </Button>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
