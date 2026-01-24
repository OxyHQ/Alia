import { View, ScrollView, TextInput as RNTextInput, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { useRouter } from "expo-router";
import { ArrowLeft } from "lucide-react-native";
import { useCreateOrganization } from "@/lib/hooks/use-organization";
import { toast } from "@/components/sonner";
import { useColorScheme } from '@/lib/useColorScheme';

export default function NewOrganizationScreen() {
  const router = useRouter();
  const { colors } = useColorScheme();
  const createOrgMutation = useCreateOrganization();

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");

  const handleNameChange = (text: string) => {
    setName(text);
    // Auto-generate slug from name if slug is empty
    if (!slug || slug === generateSlug(name)) {
      setSlug(generateSlug(text));
    }
  };

  const generateSlug = (text: string) => {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      toast.error("Please enter an organization name");
      return;
    }

    if (!slug.trim()) {
      toast.error("Please enter a slug");
      return;
    }

    // Validate slug format
    if (!/^[a-z0-9-]+$/.test(slug)) {
      toast.error("Slug must be lowercase alphanumeric with hyphens");
      return;
    }

    try {
      const newOrg = await createOrgMutation.mutateAsync({
        name: name.trim(),
        slug: slug.trim(),
        description: description.trim() || undefined,
      });

      toast.success("Organization created successfully");
      router.back();
    } catch (error: any) {
      toast.error(error.message || "Failed to create organization");
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
        <Text className="text-2xl font-semibold text-foreground">Create organization</Text>
        <Text className="text-sm text-muted-foreground mt-1">
          Set up a new organization for your team
        </Text>
      </View>

      {/* Organization Name */}
      <View className="px-6 py-6 border-b border-border">
        <Text className="text-sm font-semibold text-foreground mb-4">Organization name</Text>
        <RNTextInput
          value={name}
          onChangeText={handleNameChange}
          placeholder="Acme Inc."
          className="w-full px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm mb-2"
          placeholderTextColor={colors.mutedForeground}
          maxLength={100}
        />
        <Text className="text-sm text-muted-foreground">
          The name of your company or organization
        </Text>
      </View>

      {/* Slug */}
      <View className="px-6 py-6 border-b border-border">
        <Text className="text-sm font-semibold text-foreground mb-4">Slug</Text>
        <RNTextInput
          value={slug}
          onChangeText={setSlug}
          placeholder="acme-inc"
          autoCapitalize="none"
          autoCorrect={false}
          className="w-full px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm mb-2"
          placeholderTextColor={colors.mutedForeground}
          maxLength={50}
        />
        <Text className="text-sm text-muted-foreground">
          Lowercase alphanumeric characters and hyphens only
        </Text>
      </View>

      {/* Description */}
      <View className="px-6 py-6 border-b border-border">
        <Text className="text-sm font-semibold text-foreground mb-4">Description</Text>
        <RNTextInput
          value={description}
          onChangeText={setDescription}
          placeholder="Describe your organization..."
          multiline
          numberOfLines={4}
          className="w-full px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm mb-2"
          placeholderTextColor={colors.mutedForeground}
          style={{ textAlignVertical: "top" }}
          maxLength={500}
        />
        <Text className="text-sm text-muted-foreground">
          {description.length}/500 characters
        </Text>
      </View>

      {/* Info Box */}
      <View className="px-6 py-6 border-b border-border">
        <View className="p-4 rounded-md bg-blue-50 border border-blue-200">
          <Text className="text-sm font-semibold text-blue-900 mb-2">
            Organization features
          </Text>
          <Text className="text-sm text-blue-800 mb-2">
            • Shared billing and credits
          </Text>
          <Text className="text-sm text-blue-800 mb-2">
            • Team member management
          </Text>
          <Text className="text-sm text-blue-800">
            • Centralized app management
          </Text>
        </View>
      </View>

      {/* Buttons */}
      <View className="px-6 py-6">
        <View className="flex-row gap-3">
          <Button
            variant="outline"
            onPress={() => router.back()}
            disabled={createOrgMutation.isPending}
            size="sm"
          >
            <Text className="text-foreground font-medium text-sm">Cancel</Text>
          </Button>
          <Button
            onPress={handleCreate}
            disabled={createOrgMutation.isPending || !name.trim() || !slug.trim()}
            size="sm"
          >
            <Text className="text-primary-foreground font-medium text-sm">
              {createOrgMutation.isPending ? "Creating..." : "Create organization"}
            </Text>
          </Button>
        </View>
      </View>
    </ScrollView>
  );
}
