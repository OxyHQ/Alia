import { View, ScrollView, TextInput as RNTextInput, Alert, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useState } from "react";
import { useRouter } from "expo-router";
import { ArrowLeft, Package } from "lucide-react-native";
import { useDeveloperStore } from "@/lib/stores/developer-store";

export default function NewAppScreen() {
  const router = useRouter();
  const { createApp } = useDeveloperStore();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    if (!name.trim()) {
      Alert.alert("Error", "Please enter an app name");
      return;
    }

    setCreating(true);
    try {
      const newApp = await createApp({
        name: name.trim(),
        description: description.trim() || undefined,
        websiteUrl: websiteUrl.trim() || undefined,
      });

      Alert.alert("Success", "App created successfully!", [
        {
          text: "OK",
          onPress: () => router.push(`/developers/apps/${newApp._id}`),
        },
      ]);
    } catch (error: any) {
      Alert.alert("Error", error.message || "Failed to create app");
    } finally {
      setCreating(false);
    }
  };

  return (
    <ScrollView className="flex-1 bg-background">
      {/* Header */}
      <View className="px-6 py-4 border-b border-border">
        <Pressable onPress={() => router.back()} className="flex-row items-center mb-4">
          <ArrowLeft size={20} className="text-muted-foreground mr-2" />
          <Text className="text-base text-muted-foreground">Back</Text>
        </Pressable>

        <View className="flex-row items-center">
          <View className="w-14 h-14 rounded-2xl bg-primary/10 items-center justify-center mr-4">
            <Package size={28} className="text-primary" />
          </View>
          <View className="flex-1">
            <Text className="text-3xl font-bold text-foreground">Create App</Text>
            <Text className="text-base text-muted-foreground mt-1">
              Set up a new application
            </Text>
          </View>
        </View>
      </View>

      {/* Form */}
      <View className="px-6 py-6">
        <Card className="p-6">
          {/* App Name */}
          <View className="mb-6">
            <Text className="text-sm font-semibold text-foreground mb-2">
              App Name <Text className="text-destructive">*</Text>
            </Text>
            <RNTextInput
              value={name}
              onChangeText={setName}
              placeholder="My Awesome App"
              className="w-full px-4 py-3 rounded-xl border border-border bg-background text-foreground"
              placeholderTextColor="#9CA3AF"
              maxLength={100}
            />
            <Text className="text-xs text-muted-foreground mt-1">
              A friendly name for your application
            </Text>
          </View>

          {/* Description */}
          <View className="mb-6">
            <Text className="text-sm font-semibold text-foreground mb-2">
              Description
            </Text>
            <RNTextInput
              value={description}
              onChangeText={setDescription}
              placeholder="Describe what your app does..."
              multiline
              numberOfLines={4}
              className="w-full px-4 py-3 rounded-xl border border-border bg-background text-foreground"
              placeholderTextColor="#9CA3AF"
              style={{ textAlignVertical: "top" }}
              maxLength={500}
            />
            <Text className="text-xs text-muted-foreground mt-1">
              {description.length}/500 characters
            </Text>
          </View>

          {/* Website URL */}
          <View className="mb-6">
            <Text className="text-sm font-semibold text-foreground mb-2">
              Website URL
            </Text>
            <RNTextInput
              value={websiteUrl}
              onChangeText={setWebsiteUrl}
              placeholder="https://example.com"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              className="w-full px-4 py-3 rounded-xl border border-border bg-background text-foreground"
              placeholderTextColor="#9CA3AF"
            />
            <Text className="text-xs text-muted-foreground mt-1">
              Optional: Your application's homepage
            </Text>
          </View>

          {/* Buttons */}
          <View className="flex-row space-x-3 mt-4">
            <Button
              variant="outline"
              onPress={() => router.back()}
              className="flex-1"
              disabled={creating}
            >
              <Text className="text-foreground font-semibold">Cancel</Text>
            </Button>
            <Button
              onPress={handleCreate}
              className="flex-1"
              disabled={creating || !name.trim()}
            >
              <Text className="text-primary-foreground font-semibold">
                {creating ? "Creating..." : "Create App"}
              </Text>
            </Button>
          </View>
        </Card>
      </View>
    </ScrollView>
  );
}
