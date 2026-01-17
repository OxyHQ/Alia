import { View, ScrollView, TextInput as RNTextInput, Pressable, Switch } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useState, useEffect } from "react";
import { useRouter, useLocalSearchParams } from "expo-router";
import { ArrowLeft } from "lucide-react-native";
import { useApp, useUpdateApp } from "@/lib/hooks/use-developer";
import { toast } from "@/components/sonner";

export default function AppSettingsScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: currentApp, isLoading } = useApp(id!);
  const updateAppMutation = useUpdateApp();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [isActive, setIsActive] = useState(true);

  useEffect(() => {
    if (currentApp) {
      setName(currentApp.name);
      setDescription(currentApp.description || "");
      setWebsiteUrl(currentApp.websiteUrl || "");
      setIsActive(currentApp.isActive);
    }
  }, [currentApp]);

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error("App name is required");
      return;
    }

    try {
      await updateAppMutation.mutateAsync({
        id: id!,
        data: {
          name: name.trim(),
          description: description.trim() || undefined,
          websiteUrl: websiteUrl.trim() || undefined,
          isActive,
        },
      });
      toast.success("App settings updated");
      router.back();
    } catch (error: any) {
      toast.error(error.message || "Failed to update app");
    }
  };

  if (isLoading) {
    return (
      <View className="flex-1 bg-background px-6 py-6">
        <Text className="text-sm text-muted-foreground">Loading...</Text>
      </View>
    );
  }

  return (
    <ScrollView className="flex-1 bg-background">
      {/* Header */}
      <View className="px-6 py-6 border-b border-border">
        <Pressable onPress={() => router.back()} className="flex-row items-center mb-4">
          <ArrowLeft size={16} className="text-muted-foreground mr-2" />
          <Text className="text-sm text-muted-foreground">Back</Text>
        </Pressable>
        <Text className="text-2xl font-semibold text-foreground">App settings</Text>
        {currentApp && (
          <Text className="text-sm text-muted-foreground mt-1">
            {currentApp.name}
          </Text>
        )}
      </View>

      {/* App Name */}
      <View className="px-6 py-6 border-b border-border">
        <Text className="text-sm font-semibold text-foreground mb-4">App name</Text>
        <RNTextInput
          value={name}
          onChangeText={setName}
          placeholder="My Awesome App"
          className="w-full px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm mb-2"
          placeholderTextColor="#9CA3AF"
          maxLength={100}
        />
        <Text className="text-sm text-muted-foreground">
          A friendly name for your application
        </Text>
      </View>

      {/* Description */}
      <View className="px-6 py-6 border-b border-border">
        <Text className="text-sm font-semibold text-foreground mb-4">Description</Text>
        <RNTextInput
          value={description}
          onChangeText={setDescription}
          placeholder="Describe what your app does..."
          multiline
          numberOfLines={4}
          className="w-full px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm mb-2"
          placeholderTextColor="#9CA3AF"
          style={{ textAlignVertical: "top" }}
          maxLength={500}
        />
        <Text className="text-sm text-muted-foreground">
          {description.length}/500 characters
        </Text>
      </View>

      {/* Website URL */}
      <View className="px-6 py-6 border-b border-border">
        <Text className="text-sm font-semibold text-foreground mb-4">Website URL</Text>
        <RNTextInput
          value={websiteUrl}
          onChangeText={setWebsiteUrl}
          placeholder="https://example.com"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          className="w-full px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm mb-2"
          placeholderTextColor="#9CA3AF"
        />
        <Text className="text-sm text-muted-foreground">Optional</Text>
      </View>

      {/* Status */}
      <View className="px-6 py-6 border-b border-border">
        <View className="flex-row items-center justify-between">
          <View className="flex-1 mr-4">
            <Text className="text-sm font-semibold text-foreground mb-1">Active status</Text>
            <Text className="text-sm text-muted-foreground">
              Inactive apps cannot make API requests
            </Text>
          </View>
          <Switch
            value={isActive}
            onValueChange={setIsActive}
            trackColor={{ false: "#cbd5e1", true: "#3b82f6" }}
            thumbColor="#ffffff"
          />
        </View>
      </View>

      {/* Buttons */}
      <View className="px-6 py-6">
        <View className="flex-row gap-3">
          <Button
            variant="outline"
            onPress={() => router.back()}
            disabled={updateAppMutation.isPending}
            size="sm"
          >
            <Text className="text-foreground font-medium text-sm">Cancel</Text>
          </Button>
          <Button
            onPress={handleSave}
            disabled={updateAppMutation.isPending || !name.trim()}
            size="sm"
          >
            <Text className="text-primary-foreground font-medium text-sm">
              {updateAppMutation.isPending ? "Saving..." : "Save changes"}
            </Text>
          </Button>
        </View>
      </View>
    </ScrollView>
  );
}
