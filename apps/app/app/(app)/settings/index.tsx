import { View, ScrollView, TextInput as RNTextInput, Pressable, Alert } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useState, useEffect } from "react";
import { useAuthStore } from "@/lib/stores/auth-store";
import { useRouter } from "expo-router";
import { generateAPIUrl } from "@/lib/generate-api-url";
import { Globe, MapPin, Briefcase, User as UserIcon, Languages, MessageSquare, ChevronDown, Check, ChevronRight, Brain, User, Moon, Sun, Monitor } from "lucide-react-native";
import { useUserData } from "@/hooks/useUserData";
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
  const { token, isAuthenticated } = useAuthStore();
  const { memory, loading } = useUserData();
  const setMemory = useUserDataStore((state) => state.setMemory);
  const [saving, setSaving] = useState(false);
  const { mode, setColorScheme } = useColorScheme();

  // Form state
  const [language, setLanguage] = useState("");
  const [tone, setTone] = useState("");
  const [occupation, setOccupation] = useState("");
  const [location, setLocation] = useState("");
  const [bio, setBio] = useState("");
  const [interests, setInterests] = useState("");

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
    if (!token) return;

    setSaving(true);
    try {
      // Save preferences
      const preferencesUrl = generateAPIUrl('/api/memory/preferences');
      const prefRes = await fetch(preferencesUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          language,
          tone,
          interests: interests.split(",").map(i => i.trim()).filter(Boolean),
        }),
      });

      // Save context
      const contextUrl = generateAPIUrl('/api/memory/context');
      const contextRes = await fetch(contextUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
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
        Alert.alert("Success", "Preferences saved successfully");
        router.back();
      }
    } catch (error) {
      console.error("Error saving memory:", error);
      Alert.alert("Error", "Failed to save preferences");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <Text>Loading...</Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <View className="border-b border-border p-4">
        <Text className="text-2xl font-bold">Settings</Text>
        <Text className="text-sm text-muted-foreground mt-1">
          Customize Alia's responses to your preferences
        </Text>
      </View>

      <ScrollView className="flex-1 p-4">
        <View className="max-w-2xl mx-auto w-full gap-6">
          {/* Quick Links */}
          <View className="gap-3">
            <Text className="text-sm font-semibold text-muted-foreground">QUICK ACCESS</Text>

            <Pressable
              onPress={() => router.push("/(app)/settings/memory")}
              className="border border-border rounded-lg p-4 bg-card flex-row items-center justify-between active:bg-muted"
            >
              <View className="flex-row items-center gap-3">
                <View className="bg-primary/10 p-2 rounded-lg">
                  <Brain size={24} className="text-primary" />
                </View>
                <View>
                  <Text className="text-base font-semibold">Memory Management</Text>
                  <Text className="text-sm text-muted-foreground">
                    Manage what Alia remembers
                  </Text>
                </View>
              </View>
              <ChevronRight size={20} className="text-muted-foreground" />
            </Pressable>

            <Pressable
              onPress={() => router.push("/(app)/settings/account")}
              className="border border-border rounded-lg p-4 bg-card flex-row items-center justify-between active:bg-muted"
            >
              <View className="flex-row items-center gap-3">
                <View className="bg-primary/10 p-2 rounded-lg">
                  <User size={24} className="text-primary" />
                </View>
                <View>
                  <Text className="text-base font-semibold">Account Settings</Text>
                  <Text className="text-sm text-muted-foreground">
                    Manage your account
                  </Text>
                </View>
              </View>
              <ChevronRight size={20} className="text-muted-foreground" />
            </Pressable>
          </View>

          <View className="border-t border-border" />

          {/* Preferences Section */}
          <Text className="text-sm font-semibold text-muted-foreground">PREFERENCES</Text>

          {/* Theme Preference */}
          <View className="gap-2">
            <View className="flex-row items-center gap-2">
              <Monitor size={20} className="text-primary" />
              <Text className="text-base font-semibold">Appearance</Text>
            </View>
            <Text className="text-sm text-muted-foreground">
              Choose your preferred color scheme
            </Text>
            <ToggleGroup
              type="single"
              value={mode}
              onValueChange={(value) => setColorScheme(value as ThemeMode)}
              className="flex-row gap-2"
            >
              <ToggleGroupItem value="light" className="flex-1">
                <View className="flex-row items-center justify-center gap-2">
                  <Sun size={16} className={mode === 'light' ? 'text-primary-foreground' : 'text-foreground'} />
                  <Text className={mode === 'light' ? 'text-primary-foreground' : 'text-foreground'}>Light</Text>
                </View>
              </ToggleGroupItem>
              <ToggleGroupItem value="dark" className="flex-1">
                <View className="flex-row items-center justify-center gap-2">
                  <Moon size={16} className={mode === 'dark' ? 'text-primary-foreground' : 'text-foreground'} />
                  <Text className={mode === 'dark' ? 'text-primary-foreground' : 'text-foreground'}>Dark</Text>
                </View>
              </ToggleGroupItem>
              <ToggleGroupItem value="system" className="flex-1">
                <View className="flex-row items-center justify-center gap-2">
                  <Monitor size={16} className={mode === 'system' ? 'text-primary-foreground' : 'text-foreground'} />
                  <Text className={mode === 'system' ? 'text-primary-foreground' : 'text-foreground'}>System</Text>
                </View>
              </ToggleGroupItem>
            </ToggleGroup>
          </View>

          {/* Language Preference */}
          <View className="gap-2">
            <View className="flex-row items-center gap-2">
              <Languages size={20} className="text-primary" />
              <Text className="text-base font-semibold">Language</Text>
            </View>
            <Text className="text-sm text-muted-foreground">
              Alia will respond in this language
            </Text>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Pressable className="border border-border rounded-lg px-4 py-3 bg-background flex-row items-center justify-between">
                  <Text className="text-foreground">
                    {language || "Select a language"}
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
              <Text className="text-base font-semibold">Response Tone</Text>
            </View>
            <Text className="text-sm text-muted-foreground">
              How Alia should communicate with you
            </Text>
            <RNTextInput
              className="border border-border rounded-lg px-4 py-3 bg-background text-foreground"
              placeholder="e.g., casual, professional, friendly"
              value={tone}
              onChangeText={setTone}
            />
          </View>

          {/* Occupation */}
          <View className="gap-2">
            <View className="flex-row items-center gap-2">
              <Briefcase size={20} className="text-primary" />
              <Text className="text-base font-semibold">Occupation</Text>
            </View>
            <Text className="text-sm text-muted-foreground">
              Your job or field of work
            </Text>
            <RNTextInput
              className="border border-border rounded-lg px-4 py-3 bg-background text-foreground"
              placeholder="e.g., Software Engineer, Teacher"
              value={occupation}
              onChangeText={setOccupation}
            />
          </View>

          {/* Location */}
          <View className="gap-2">
            <View className="flex-row items-center gap-2">
              <MapPin size={20} className="text-primary" />
              <Text className="text-base font-semibold">Location</Text>
            </View>
            <Text className="text-sm text-muted-foreground">
              Where you're based
            </Text>
            <RNTextInput
              className="border border-border rounded-lg px-4 py-3 bg-background text-foreground"
              placeholder="e.g., New York, USA"
              value={location}
              onChangeText={setLocation}
            />
          </View>

          {/* Bio */}
          <View className="gap-2">
            <View className="flex-row items-center gap-2">
              <UserIcon size={20} className="text-primary" />
              <Text className="text-base font-semibold">About You</Text>
            </View>
            <Text className="text-sm text-muted-foreground">
              Tell Alia a bit about yourself
            </Text>
            <RNTextInput
              className="border border-border rounded-lg px-4 py-3 bg-background text-foreground"
              placeholder="e.g., I love hiking and building web apps"
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
              <Text className="text-base font-semibold">Interests</Text>
            </View>
            <Text className="text-sm text-muted-foreground">
              Topics you're interested in (comma-separated)
            </Text>
            <RNTextInput
              className="border border-border rounded-lg px-4 py-3 bg-background text-foreground"
              placeholder="e.g., AI, Technology, Travel"
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
              <Text>Cancel</Text>
            </Button>
            <Button
              className="flex-1"
              onPress={handleSave}
              disabled={saving}
            >
              <Text>{saving ? "Saving..." : "Save Preferences"}</Text>
            </Button>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
