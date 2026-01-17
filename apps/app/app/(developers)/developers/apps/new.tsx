import { View, ScrollView, TextInput as RNTextInput, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { useRouter } from "expo-router";
import { ArrowLeft } from "lucide-react-native";
import { useCreateApp } from "@/lib/hooks/use-developer";
import { toast } from "@/components/sonner";

export default function NewAppScreen() {
  const router = useRouter();
  const createAppMutation = useCreateApp();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");

  const handleCreate = async () => {
    if (!name.trim()) {
      toast.error("Please enter an app name");
      return;
    }

    try {
      const newApp = await createAppMutation.mutateAsync({
        name: name.trim(),
        description: description.trim() || undefined,
        websiteUrl: websiteUrl.trim() || undefined,
      });

      // Navigate directly to the new app's detail page
      router.push(`/developers/apps/${newApp._id}`);
    } catch (error: any) {
      toast.error(error.message || "Failed to create app");
    }
  };

  return (
    <ScrollView className="flex-1 bg-background">
      {/* Header */}
      <View className="px-6 py-6 border-b border-border">
        <Pressable onPress={() => router.back()} className="flex-row items-center mb-4">
          <ArrowLeft size={16} className="text-muted-foreground mr-2" />
          <Text className="text-sm text-muted-foreground">Back</Text>
        </Pressable>
        <Text className="text-2xl font-semibold text-foreground">Create new app</Text>
      </View>

      {/* Form */}
      <View className="px-6 py-6">
        {/* App Name */}
        <View className="mb-6">
          <Text className="text-sm font-semibold text-foreground mb-2">
            App name
          </Text>
          <RNTextInput
            value={name}
            onChangeText={setName}
            placeholder="My Awesome App"
            className="w-full px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm"
            placeholderTextColor="#9CA3AF"
            maxLength={100}
          />
          <Text className="text-xs text-muted-foreground mt-1.5">
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
            className="w-full px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm"
            placeholderTextColor="#9CA3AF"
            style={{ textAlignVertical: "top" }}
            maxLength={500}
          />
          <Text className="text-xs text-muted-foreground mt-1.5">
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
            className="w-full px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm"
            placeholderTextColor="#9CA3AF"
          />
          <Text className="text-xs text-muted-foreground mt-1.5">
            Optional
          </Text>
        </View>

        {/* Buttons */}
        <View className="flex-row gap-3 pt-4">
          <Button
            variant="outline"
            onPress={() => router.back()}
            disabled={createAppMutation.isPending}
            size="sm"
          >
            <Text className="text-foreground font-medium text-sm">Cancel</Text>
          </Button>
          <Button
            onPress={handleCreate}
            disabled={createAppMutation.isPending || !name.trim()}
            size="sm"
          >
            <Text className="text-primary-foreground font-medium text-sm">
              {createAppMutation.isPending ? "Creating..." : "Create"}
            </Text>
          </Button>
        </View>
      </View>
    </ScrollView>
  );
}
