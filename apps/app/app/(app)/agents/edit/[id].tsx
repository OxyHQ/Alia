import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  View,
  ScrollView,
  Pressable,
  Switch,
  TextInput,
  Alert,
  useWindowDimensions,
} from "react-native";
import { Text } from "@/components/ui/text";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarImage } from "@/components/ui/avatar";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Panel } from "@/components/ui/panel";
import {
  ArrowLeft,
  X,
  Share2,
  Trash2,
  Plus,
  Ellipsis,
  Settings,
  Layers,
  ChevronRight,
  Zap,
  Tag,
  Check,
} from "lucide-react-native";
import * as DropdownMenu from "@/components/ui/dropdown-menu";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const DEFAULT_AVATAR = require("@/assets/images/agent-avatar-reference.png");
import { useRouter, useLocalSearchParams } from "expo-router";
import { useAgentsStore, type Agent } from "@/lib/stores/agents-store";
import { useTranslation } from "@/hooks/useTranslation";
import { useColorScheme } from "@/lib/useColorScheme";
import { toast } from "@/components/sonner";
import { cn } from "@/lib/utils";

const CATEGORIES = [
  "Assistant",
  "Creative",
  "Developer",
  "Research",
  "Business",
  "Education",
];

type SidebarTab = "resources" | "settings";

export default function EditAgentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const { width } = useWindowDimensions();
  const isLargeScreen = width >= 768;
  const getAgent = useAgentsStore((state) => state.getAgent);
  const updateAgent = useAgentsStore((state) => state.updateAgent);
  const deleteAgent = useAgentsStore((state) => state.deleteAgent);

  // Loading
  const [loading, setLoading] = useState(true);

  // Form state
  const [name, setName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [tagline, setTagline] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [category, setCategory] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [capabilityInput, setCapabilityInput] = useState("");
  const [price, setPrice] = useState("");
  const [allowHiring, setAllowHiring] = useState(false);
  const [isPublished, setIsPublished] = useState(false);

  // UI state
  const [saving, setSaving] = useState(false);
  const [showPanel, setShowPanel] = useState(isLargeScreen);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("resources");

  // Auto-save debounce
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const isInitialLoad = useRef(true);

  // Load agent data
  useEffect(() => {
    if (!id) return;
    setLoading(true);
    getAgent(id).then((agent) => {
      if (agent) {
        setName(agent.name);
        setAvatarUrl(agent.avatar || null);
        setTagline(agent.tagline);
        setDescription(agent.description);
        setSystemPrompt(agent.systemPrompt || "");
        setCategory(agent.category);
        setTags(agent.tags || []);
        setCapabilities(agent.capabilities || []);
        setPrice(agent.price != null ? String(agent.price) : "");
        setAllowHiring(agent.allowHiring);
        setIsPublished(agent.isPublished);
      }
      setLoading(false);
      // Mark initial load as done after a tick
      setTimeout(() => {
        isInitialLoad.current = false;
      }, 500);
    });
  }, [id, getAgent]);

  // Debounced auto-save
  const debouncedSave = useCallback(
    (updates: Partial<Agent>) => {
      if (!id || isInitialLoad.current) return;
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(async () => {
        setSaving(true);
        try {
          await updateAgent(id, updates);
        } catch {
          // silent
        } finally {
          setSaving(false);
        }
      }, 1000);
    },
    [id, updateAgent]
  );

  // Auto-save on field changes
  useEffect(() => {
    debouncedSave({
      name,
      tagline,
      description,
      systemPrompt,
      category,
      tags,
      capabilities,
      price: price.trim() ? parseFloat(price) : null,
      allowHiring,
    });
  }, [
    name,
    tagline,
    description,
    systemPrompt,
    category,
    tags,
    capabilities,
    price,
    allowHiring,
    debouncedSave,
  ]);

  const handlePublishToggle = useCallback(async () => {
    if (!id) return;
    const newValue = !isPublished;
    setIsPublished(newValue);
    try {
      await updateAgent(id, { isPublished: newValue });
      toast.success(newValue ? t("agents.published") : t("agents.draft"));
    } catch {
      setIsPublished(!newValue);
      toast.error("Failed to update");
    }
  }, [id, isPublished, updateAgent, t]);

  const handleDelete = useCallback(() => {
    if (!id) return;
    Alert.alert(t("agents.deleteAgent"), t("agents.deleteAgentConfirm"), [
      { text: "Cancel", style: "cancel" },
      {
        text: t("agents.deleteAgent"),
        style: "destructive",
        onPress: async () => {
          try {
            await deleteAgent(id);
            toast.success(t("agents.agentDeleted"));
            router.back();
          } catch {
            toast.error("Failed to delete agent");
          }
        },
      },
    ]);
  }, [id, deleteAgent, router, t]);

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

  if (loading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <Text className="text-muted-foreground">{t("common.loading")}</Text>
      </View>
    );
  }

  // Sidebar content
  const sidebarContent = (
    <View className="flex-1 bg-background">
      {/* Sidebar Header */}
      <View className="flex-row items-center justify-between px-4 py-3 border-b border-border">
        <Text className="text-base font-semibold text-foreground">
          {sidebarTab === "resources"
            ? t("agents.resources")
            : t("agents.settings")}
        </Text>
        {!isLargeScreen && (
          <Pressable
            className="p-1 rounded-lg active:opacity-70"
            onPress={() => setShowPanel(false)}
          >
            <X size={20} className="text-muted-foreground" />
          </Pressable>
        )}
      </View>

      {/* Tabs */}
      <View className="flex-row border-b border-border">
        <Pressable
          onPress={() => setSidebarTab("resources")}
          className={cn(
            "flex-1 py-2.5 items-center",
            sidebarTab === "resources" && "border-b-2 border-primary"
          )}
        >
          <Text
            className={cn(
              "text-sm font-medium",
              sidebarTab === "resources"
                ? "text-foreground"
                : "text-muted-foreground"
            )}
          >
            {t("agents.resources")}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setSidebarTab("settings")}
          className={cn(
            "flex-1 py-2.5 items-center",
            sidebarTab === "settings" && "border-b-2 border-primary"
          )}
        >
          <Text
            className={cn(
              "text-sm font-medium",
              sidebarTab === "settings"
                ? "text-foreground"
                : "text-muted-foreground"
            )}
          >
            {t("agents.settings")}
          </Text>
        </Pressable>
      </View>

      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {sidebarTab === "resources" ? (
          <View className="p-4 gap-5">
            {/* Skills / Capabilities */}
            <View className="gap-2">
              <View className="flex-row items-center justify-between">
                <View className="flex-row items-center gap-2">
                  <Zap size={16} className="text-foreground" />
                  <Text className="text-sm font-semibold text-foreground">
                    {t("agents.skills")}
                  </Text>
                </View>
              </View>
              {capabilities.map((cap) => (
                <View
                  key={cap}
                  className="flex-row items-center justify-between py-2 px-3 rounded-lg border border-border"
                >
                  <Text className="text-sm text-foreground flex-1" numberOfLines={1}>
                    {cap}
                  </Text>
                  <Pressable
                    onPress={() => removeCapability(cap)}
                    className="active:opacity-70 ml-2"
                  >
                    <X size={14} className="text-muted-foreground" />
                  </Pressable>
                </View>
              ))}
              <View className="flex-row gap-2">
                <Input
                  value={capabilityInput}
                  onChangeText={setCapabilityInput}
                  placeholder={t("agents.addSkill")}
                  placeholderTextColor={colors.mutedForeground}
                  className="flex-1 h-9"
                  onSubmitEditing={addCapability}
                  returnKeyType="done"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 px-3"
                  onPress={addCapability}
                  disabled={!capabilityInput.trim()}
                >
                  <Plus size={14} className="text-foreground" />
                </Button>
              </View>
            </View>

            {/* Knowledge / Tags */}
            <View className="gap-2">
              <View className="flex-row items-center justify-between">
                <View className="flex-row items-center gap-2">
                  <Tag size={16} className="text-foreground" />
                  <Text className="text-sm font-semibold text-foreground">
                    {t("agents.knowledge")}
                  </Text>
                </View>
              </View>
              {tags.map((tag) => (
                <View
                  key={tag}
                  className="flex-row items-center justify-between py-2 px-3 rounded-lg border border-border"
                >
                  <Text className="text-sm text-foreground flex-1" numberOfLines={1}>
                    {tag}
                  </Text>
                  <Pressable
                    onPress={() => removeTag(tag)}
                    className="active:opacity-70 ml-2"
                  >
                    <X size={14} className="text-muted-foreground" />
                  </Pressable>
                </View>
              ))}
              <View className="flex-row gap-2">
                <Input
                  value={tagInput}
                  onChangeText={setTagInput}
                  placeholder={t("agents.addKnowledge")}
                  placeholderTextColor={colors.mutedForeground}
                  className="flex-1 h-9"
                  onSubmitEditing={addTag}
                  returnKeyType="done"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 px-3"
                  onPress={addTag}
                  disabled={!tagInput.trim()}
                >
                  <Plus size={14} className="text-foreground" />
                </Button>
              </View>
            </View>
          </View>
        ) : (
          <View className="p-4 gap-4">
            {/* Category */}
            <View className="gap-1.5">
              <Label>Category</Label>
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

            {/* Tagline */}
            <View className="gap-1.5">
              <Label>Tagline</Label>
              <Input
                value={tagline}
                onChangeText={setTagline}
                placeholder="Short description"
                placeholderTextColor={colors.mutedForeground}
              />
            </View>

            {/* Description */}
            <View className="gap-1.5">
              <Label>Description</Label>
              <Textarea
                value={description}
                onChangeText={setDescription}
                placeholder="Full description..."
                placeholderTextColor={colors.mutedForeground}
              />
            </View>

            {/* Price */}
            <View className="gap-1.5">
              <Label>Price per use (USD)</Label>
              <Input
                value={price}
                onChangeText={setPrice}
                placeholder="Free (leave empty)"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="decimal-pad"
              />
            </View>

            {/* Allow Hiring */}
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
          </View>
        )}
      </ScrollView>
    </View>
  );

  return (
    <View className="flex-1 bg-background flex-row">
      {/* Main Content */}
      <View className="flex-1">
        {/* Header */}
        <View className="flex-row items-center justify-between px-4 py-3 border-b border-border">
          <View className="flex-row items-center gap-3">
            <Pressable
              onPress={() => router.back()}
              className="active:opacity-70"
            >
              <ArrowLeft size={20} className="text-foreground" />
            </Pressable>
            <Text className="text-sm font-medium text-foreground">
              {t("agents.instructions")}
            </Text>
            <ChevronRight size={14} className="text-muted-foreground" />
            <View
              className={cn(
                "px-2 py-0.5 rounded-full",
                isPublished ? "bg-green-500/15" : "bg-muted"
              )}
            >
              <Text
                className={cn(
                  "text-xs font-medium",
                  isPublished ? "text-green-500" : "text-muted-foreground"
                )}
              >
                {isPublished ? t("agents.published") : t("agents.draft")}
              </Text>
            </View>
            {saving && (
              <Text className="text-xs text-muted-foreground ml-2">
                {t("agents.saving")}
              </Text>
            )}
          </View>
          <View className="flex-row items-center gap-2">
            {!isLargeScreen && (
              <Pressable
                onPress={() => setShowPanel(true)}
                className="p-2 active:opacity-70"
              >
                <Settings size={18} className="text-foreground" />
              </Pressable>
            )}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger>
                <Pressable className="p-2">
                  <Ellipsis size={18} className="text-foreground" />
                </Pressable>
              </DropdownMenu.Trigger>
              <DropdownMenu.Content>
                <DropdownMenu.Item key="delete" onSelect={handleDelete}>
                  <DropdownMenu.ItemIcon
                    ios={{ name: "trash" }}
                  />
                  <DropdownMenu.ItemTitle>
                    {t("agents.deleteAgent")}
                  </DropdownMenu.ItemTitle>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Root>
            <Button
              onPress={handlePublishToggle}
              className="h-8 px-4 rounded-full"
            >
              <Text className="text-sm font-medium text-primary-foreground">
                {isPublished ? t("agents.unpublish") : t("agents.publish")}
              </Text>
            </Button>
          </View>
        </View>

        {/* Main Editor */}
        <ScrollView
          className="flex-1"
          contentContainerStyle={{ padding: 20, paddingBottom: 60 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Avatar + Name */}
          <View className="flex-row items-center gap-3 mb-6">
            <Avatar className="h-10 w-10">
              <AvatarImage
                source={avatarUrl ? { uri: avatarUrl } : DEFAULT_AVATAR}
              />
            </Avatar>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Agent name"
              placeholderTextColor={colors.mutedForeground}
              style={{
                fontSize: 24,
                fontWeight: "700",
                color: colors.foreground,
                flex: 1,
                padding: 0,
              }}
            />
          </View>

          {/* System Prompt / Instructions */}
          <TextInput
            value={systemPrompt}
            onChangeText={setSystemPrompt}
            placeholder={t("agents.systemPromptPlaceholder")}
            placeholderTextColor={colors.mutedForeground}
            multiline
            style={{
              fontSize: 15,
              lineHeight: 22,
              color: colors.foreground,
              minHeight: 300,
              textAlignVertical: "top",
              padding: 0,
            }}
          />
        </ScrollView>
      </View>

      {/* Right Sidebar - Desktop: inline, Mobile: Panel modal */}
      {isLargeScreen ? (
        <View
          style={{ width: 320 }}
          className="border-l border-border bg-background"
        >
          {sidebarContent}
        </View>
      ) : (
        <Panel
          open={showPanel}
          onClose={() => setShowPanel(false)}
          side="right"
          width={320}
        >
          {sidebarContent}
        </Panel>
      )}
    </View>
  );
}
