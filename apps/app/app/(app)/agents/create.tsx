import React, { useState, useCallback } from "react";
import { View, ScrollView, Pressable, Switch, ActivityIndicator } from "react-native";
import { Image } from "expo-image";
import { Text } from "@/components/ui/text";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ArrowLeft, X } from "lucide-react-native";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const REFERENCE_AVATAR = require("@/assets/images/agent-avatar-reference.png");
import { useRouter } from "expo-router";
import { useAgentsStore } from "@/lib/stores/agents-store";
import { useTranslation } from "@/hooks/useTranslation";
import { useColorScheme } from "@/lib/useColorScheme";
import { toast } from "@/components/sonner";
import apiClient from "@/lib/api/client";
import { API_ROUTES } from "@/lib/api/routes";

const CATEGORIES = [
  "Assistant",
  "Creative",
  "Developer",
  "Research",
  "Business",
  "Education",
];

export default function CreateAgentScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const createAgent = useAgentsStore((state) => state.createAgent);

  // Form state
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [handleManuallyEdited, setHandleManuallyEdited] = useState(false);
  const [tagline, setTagline] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [capabilityInput, setCapabilityInput] = useState("");
  const [price, setPrice] = useState("");
  const [allowHiring, setAllowHiring] = useState(false);
  const [isPublished, setIsPublished] = useState(true);
  const [stylePrompt, setStylePrompt] = useState("");

  // Submission state
  const [saving, setSaving] = useState(false);

  const handleNameChange = useCallback(
    (text: string) => {
      setName(text);
      if (!handleManuallyEdited) {
        const autoHandle =
          "@" +
          text
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, "")
            .replace(/\s+/g, "-")
            .replace(/-+/g, "-");
        setHandle(autoHandle);
      }
    },
    [handleManuallyEdited]
  );

  const handleHandleChange = useCallback((text: string) => {
    setHandleManuallyEdited(true);
    setHandle(text.startsWith("@") ? text : "@" + text);
  }, []);

  const addTag = useCallback(() => {
    const trimmed = tagInput.trim();
    if (trimmed && !tags.includes(trimmed)) {
      setTags((prev) => [...prev, trimmed]);
      setTagInput("");
    }
  }, [tagInput, tags]);

  const removeTag = useCallback((tag: string) => {
    setTags((prev) => prev.filter((t) => t !== tag));
  }, []);

  const addCapability = useCallback(() => {
    const trimmed = capabilityInput.trim();
    if (trimmed && !capabilities.includes(trimmed)) {
      setCapabilities((prev) => [...prev, trimmed]);
      setCapabilityInput("");
    }
  }, [capabilityInput, capabilities]);

  const removeCapability = useCallback((cap: string) => {
    setCapabilities((prev) => prev.filter((c) => c !== cap));
  }, []);

  const handleCreate = useCallback(async () => {
    // Validation
    const cleanHandle = handle.replace(/^@/, "").trim();
    if (!name.trim() || !cleanHandle || !tagline.trim() || !description.trim() || !category) {
      toast.error("Please fill in all required fields");
      return;
    }

    setSaving(true);

    try {
      // Step 1: Auto-generate avatar via AI
      let avatarUrl: string | null = null;
      try {
        const avatarRes = await apiClient.post(
          API_ROUTES.agents.generateAvatar,
          {
            name: name.trim(),
            description: description.trim(),
            ...(stylePrompt.trim() ? { prompt: stylePrompt.trim() } : {}),
          },
          { timeout: 60000 }
        );
        avatarUrl = avatarRes.data.avatarUrl;
      } catch (avatarError) {
        // Graceful degradation: create agent without avatar
        console.warn("Avatar generation failed, continuing without avatar:", avatarError);
      }

      // Step 2: Create the agent
      const agent = await createAgent({
        name: name.trim(),
        handle: cleanHandle,
        avatar: avatarUrl,
        tagline: tagline.trim(),
        description: description.trim(),
        category,
        tags,
        capabilities,
        price: price.trim() ? parseFloat(price) : null,
        allowHiring,
        isPublished,
      });

      if (agent) {
        toast.success("Agent created successfully");
        router.replace(`/(app)/agents/${agent._id}`);
      } else {
        toast.error("Failed to create agent");
      }
    } catch (error: any) {
      const message = error?.response?.data?.error || "Failed to create agent";
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }, [
    name, handle, tagline, description, category, tags, capabilities,
    price, allowHiring, isPublished, stylePrompt, createAgent, router,
  ]);

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="flex-row items-center gap-3 px-5 pt-4 pb-2">
        <Pressable onPress={() => router.back()} className="active:opacity-70">
          <ArrowLeft size={22} className="text-foreground" />
        </Pressable>
        <Text className="text-lg font-bold text-foreground">Create Agent</Text>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Avatar Preview */}
        <View className="items-center mt-4 mb-2">
          <View className="h-24 w-24 rounded-full bg-muted items-center justify-center overflow-hidden border-2 border-border">
            <Image
              source={REFERENCE_AVATAR}
              style={{ width: 96, height: 96 }}
              contentFit="cover"
            />
          </View>
          <Text className="text-[11px] text-muted-foreground mt-2 text-center px-8">
            Avatar will be auto-generated when you create the agent
          </Text>
        </View>

        {/* Style Prompt */}
        <View className="gap-1.5 mb-4">
          <Label>Avatar Style (optional)</Label>
          <Input
            value={stylePrompt}
            onChangeText={setStylePrompt}
            placeholder='e.g. "cyberpunk neon", "minimalist robot"'
            placeholderTextColor={colors.mutedForeground}
          />
        </View>

        {/* Name */}
        <View className="gap-1.5 mb-4">
          <Label>Name *</Label>
          <Input
            value={name}
            onChangeText={handleNameChange}
            placeholder="Agent name"
            placeholderTextColor={colors.mutedForeground}
          />
        </View>

        {/* Handle */}
        <View className="gap-1.5 mb-4">
          <Label>Handle *</Label>
          <Input
            value={handle}
            onChangeText={handleHandleChange}
            placeholder="@agent-handle"
            placeholderTextColor={colors.mutedForeground}
            autoCapitalize="none"
          />
        </View>

        {/* Tagline */}
        <View className="gap-1.5 mb-4">
          <Label>Tagline *</Label>
          <Input
            value={tagline}
            onChangeText={setTagline}
            placeholder="Short description (one line)"
            placeholderTextColor={colors.mutedForeground}
          />
        </View>

        {/* Description */}
        <View className="gap-1.5 mb-4">
          <Label>Description *</Label>
          <Textarea
            value={description}
            onChangeText={setDescription}
            placeholder="Full description of what this agent does..."
            placeholderTextColor={colors.mutedForeground}
          />
        </View>

        {/* Category */}
        <View className="gap-1.5 mb-4">
          <Label>Category *</Label>
          <ToggleGroup
            type="single"
            value={category}
            onValueChange={(val) => setCategory(val as string)}
          >
            {CATEGORIES.map((cat) => (
              <ToggleGroupItem key={cat} value={cat}>
                {cat}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </View>

        {/* Tags */}
        <View className="gap-1.5 mb-4">
          <Label>Tags</Label>
          <View className="flex-row gap-2">
            <Input
              value={tagInput}
              onChangeText={setTagInput}
              placeholder="Add a tag"
              placeholderTextColor={colors.mutedForeground}
              className="flex-1"
              onSubmitEditing={addTag}
              returnKeyType="done"
            />
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl h-11"
              onPress={addTag}
            >
              <Text className="text-sm font-medium text-foreground">Add</Text>
            </Button>
          </View>
          {tags.length > 0 && (
            <View className="flex-row flex-wrap gap-1.5 mt-1.5">
              {tags.map((tag) => (
                <Pressable
                  key={tag}
                  onPress={() => removeTag(tag)}
                  className="flex-row items-center gap-1 bg-muted rounded-full px-2.5 py-1 active:opacity-70"
                >
                  <Text className="text-xs text-foreground">{tag}</Text>
                  <X size={11} className="text-muted-foreground" />
                </Pressable>
              ))}
            </View>
          )}
        </View>

        {/* Capabilities */}
        <View className="gap-1.5 mb-4">
          <Label>Capabilities</Label>
          <View className="flex-row gap-2">
            <Input
              value={capabilityInput}
              onChangeText={setCapabilityInput}
              placeholder="Add a capability"
              placeholderTextColor={colors.mutedForeground}
              className="flex-1"
              onSubmitEditing={addCapability}
              returnKeyType="done"
            />
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl h-11"
              onPress={addCapability}
            >
              <Text className="text-sm font-medium text-foreground">Add</Text>
            </Button>
          </View>
          {capabilities.length > 0 && (
            <View className="flex-row flex-wrap gap-1.5 mt-1.5">
              {capabilities.map((cap) => (
                <Pressable
                  key={cap}
                  onPress={() => removeCapability(cap)}
                  className="flex-row items-center gap-1 bg-muted rounded-full px-2.5 py-1 active:opacity-70"
                >
                  <Text className="text-xs text-foreground">{cap}</Text>
                  <X size={11} className="text-muted-foreground" />
                </Pressable>
              ))}
            </View>
          )}
        </View>

        {/* Price */}
        <View className="gap-1.5 mb-4">
          <Label>Price per use (USD)</Label>
          <Input
            value={price}
            onChangeText={setPrice}
            placeholder="Free (leave empty)"
            placeholderTextColor={colors.mutedForeground}
            keyboardType="decimal-pad"
          />
        </View>

        {/* Toggles */}
        <View className="gap-4 mb-6">
          <View className="flex-row items-center justify-between">
            <Label>Allow Hiring</Label>
            <Switch
              value={allowHiring}
              onValueChange={setAllowHiring}
              trackColor={{
                false: colors.muted,
                true: colors.primary,
              }}
            />
          </View>
          <View className="flex-row items-center justify-between">
            <Label>Publish</Label>
            <Switch
              value={isPublished}
              onValueChange={setIsPublished}
              trackColor={{
                false: colors.muted,
                true: colors.primary,
              }}
            />
          </View>
        </View>

        {/* Submit */}
        <Button
          className="rounded-xl h-12 mb-4"
          onPress={handleCreate}
          disabled={saving}
        >
          {saving ? (
            <View className="flex-row items-center gap-2">
              <ActivityIndicator size="small" color="white" />
              <Text className="text-[15px] font-semibold text-primary-foreground">
                Creating agent...
              </Text>
            </View>
          ) : (
            <Text className="text-[15px] font-semibold text-primary-foreground">
              Create Agent
            </Text>
          )}
        </Button>
      </ScrollView>
    </View>
  );
}
