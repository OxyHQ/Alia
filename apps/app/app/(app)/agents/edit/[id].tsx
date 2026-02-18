import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  View,
  ScrollView,
  Pressable,
  TextInput,
  Alert,
  useWindowDimensions,
} from "react-native";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarImage } from "@/components/ui/avatar";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Panel } from "@/components/ui/panel";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ArrowLeft,
  X,
  Plus,
  Ellipsis,
  Settings,
  ChevronRight,
  Zap,
  FileText,
  Search,
  BookOpen,
  Wrench,
  Globe,
  Terminal,
  FileDown,
  FolderOpen,
  Image,
  Brain,
  Users,
} from "lucide-react-native";
import { AGENT_TOOLS } from "@/lib/constants/agent-tools";
import * as DropdownMenu from "@/components/ui/dropdown-menu";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const DEFAULT_AVATAR = require("@/assets/images/agent-avatar-reference.png");
import { useRouter, useLocalSearchParams } from "expo-router";
import { useAgentsStore, type Agent } from "@/lib/stores/agents-store";
import { useTranslation } from "@/hooks/useTranslation";
import { useColorScheme } from "@/lib/useColorScheme";
import { toast } from "@/components/sonner";
import { cn } from "@/lib/utils";
import apiClient from "@/lib/api/client";
import { API_ROUTES } from "@/lib/api/routes";
import { useLibraryStore, type LibraryFile } from "@/lib/stores/library-store";

const TOOL_ICONS: Record<string, React.ComponentType<any>> = {
  Globe, Terminal, Search, FileDown, FolderOpen, Image, Brain, Users,
};

type LinkedSkill = { _id: string; skillId: string; title: string; icon: string; color: string };
type LinkedFile = { _id: string; name: string; type: string; category: string; url: string };

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
  const [price, setPrice] = useState("");
  const [allowHiring, setAllowHiring] = useState(false);
  const [isPublished, setIsPublished] = useState(false);

  // Linked skills & knowledge
  const [linkedSkills, setLinkedSkills] = useState<LinkedSkill[]>([]);
  const [linkedKnowledge, setLinkedKnowledge] = useState<LinkedFile[]>([]);
  const [allSkills, setAllSkills] = useState<LinkedSkill[]>([]);
  const [showSkillPicker, setShowSkillPicker] = useState(false);
  const [skillSearch, setSkillSearch] = useState("");
  const [showKnowledgePicker, setShowKnowledgePicker] = useState(false);
  const [knowledgeSearch, setKnowledgeSearch] = useState("");

  // Library files for knowledge picker
  const libraryFiles = useLibraryStore((state) => state.files);
  const loadLibraryFiles = useLibraryStore((state) => state.loadFiles);

  // UI state
  const [saving, setSaving] = useState(false);
  const [showPanel, setShowPanel] = useState(isLargeScreen);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("resources");

  // Auto-save debounce
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const isInitialLoad = useRef(true);

  // Load available skills from backend
  useEffect(() => {
    apiClient.get(API_ROUTES.skills.list).then((res) => {
      setAllSkills(res.data.skills || []);
    }).catch(() => {});
    loadLibraryFiles();
  }, [loadLibraryFiles]);

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
        setLinkedSkills(agent.skills || []);
        setLinkedKnowledge(agent.knowledge || []);
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
      skills: linkedSkills.map((s) => s._id),
      knowledge: linkedKnowledge.map((k) => k._id),
      price: price.trim() ? parseFloat(price) : null,
      allowHiring,
    } as any);
  }, [
    name,
    tagline,
    description,
    systemPrompt,
    category,
    tags,
    capabilities,
    linkedSkills,
    linkedKnowledge,
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

  const toggleCapability = useCallback((id: string) => {
    setCapabilities((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]
    );
  }, []);

  const addLinkedSkill = useCallback((skill: LinkedSkill) => {
    setLinkedSkills((prev) => {
      if (prev.some((s) => s._id === skill._id)) return prev;
      return [...prev, skill];
    });
    setShowSkillPicker(false);
    setSkillSearch("");
  }, []);

  const removeLinkedSkill = useCallback((skillId: string) => {
    setLinkedSkills((prev) => prev.filter((s) => s._id !== skillId));
  }, []);

  const addLinkedKnowledge = useCallback((file: LinkedFile) => {
    setLinkedKnowledge((prev) => {
      if (prev.some((k) => k._id === file._id)) return prev;
      return [...prev, file];
    });
    setShowKnowledgePicker(false);
    setKnowledgeSearch("");
  }, []);

  const removeLinkedKnowledge = useCallback((fileId: string) => {
    setLinkedKnowledge((prev) => prev.filter((k) => k._id !== fileId));
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
        scrollEnabled={!isLargeScreen}
        contentContainerStyle={isLargeScreen ? { flex: 1 } : undefined}
      >
        {sidebarTab === "resources" ? (
          <View className={isLargeScreen ? "flex-1" : ""}>
            {/* Linked Skills */}
            <View className={cn(isLargeScreen && "flex-1", "border-b border-border")}>
              <View className="px-4 pt-4 pb-2 flex-row items-center justify-between">
                <View className="flex-row items-center gap-2">
                  <Zap size={16} className="text-foreground" />
                  <Text className="text-sm font-semibold text-foreground">
                    {t("agents.skills")}
                  </Text>
                </View>
                <Pressable
                  onPress={() => setShowSkillPicker(!showSkillPicker)}
                  className="active:opacity-70"
                >
                  <Plus size={16} className="text-muted-foreground" />
                </Pressable>
              </View>
              <ScrollView
                className={cn(isLargeScreen && "flex-1")}
                showsVerticalScrollIndicator={false}
                scrollEnabled={isLargeScreen}
              >
                <View className="px-4 pb-4 gap-2">
                  {linkedSkills.map((skill) => (
                    <View
                      key={skill._id}
                      className="flex-row items-center justify-between py-1.5"
                    >
                      <View className="flex-row items-center gap-2 flex-1">
                        <Text style={{ fontSize: 16 }}>{skill.icon}</Text>
                        <Text className="text-sm text-foreground flex-1" numberOfLines={1}>
                          {skill.title}
                        </Text>
                      </View>
                      <Pressable
                        onPress={() => removeLinkedSkill(skill._id)}
                        className="active:opacity-70 ml-2"
                      >
                        <X size={14} className="text-muted-foreground" />
                      </Pressable>
                    </View>
                  ))}
                </View>
              </ScrollView>
              <Dialog open={showSkillPicker} onOpenChange={setShowSkillPicker}>
                <DialogContent overlayClassName={cn(!isLargeScreen && "px-0")} className={cn("p-0 gap-0", !isLargeScreen && "flex-1 max-w-none rounded-none border-0")}>
                  <DialogHeader className="px-4 pt-4 pb-2">
                    <DialogTitle>{t("agents.skills")}</DialogTitle>
                  </DialogHeader>
                  <View className="mx-4 mb-2 flex-row items-center gap-2 px-3 py-1.5 border border-border rounded-md">
                    <Search size={14} className="text-muted-foreground" />
                    <TextInput
                      value={skillSearch}
                      onChangeText={setSkillSearch}
                      placeholder="Search skills..."
                      placeholderTextColor={colors.mutedForeground}
                      className="flex-1 text-sm text-foreground"
                      autoFocus
                    />
                  </View>
                  <ScrollView style={{ maxHeight: isLargeScreen ? 300 : undefined }} className={cn(!isLargeScreen && "flex-1")}>
                    {allSkills
                      .filter((s) =>
                        !linkedSkills.some((ls) => ls._id === s._id) &&
                        (!skillSearch || s.title.toLowerCase().includes(skillSearch.toLowerCase()))
                      )
                      .map((skill) => (
                        <Pressable
                          key={skill._id}
                          onPress={() => addLinkedSkill(skill)}
                          className="flex-row items-center gap-2 px-4 py-2 active:bg-muted"
                        >
                          <Text style={{ fontSize: 16 }}>{skill.icon}</Text>
                          <Text className="text-sm text-foreground">{skill.title}</Text>
                        </Pressable>
                      ))}
                  </ScrollView>
                </DialogContent>
              </Dialog>
            </View>

            {/* Tools / Integrations */}
            <View className={cn(isLargeScreen && "flex-1", "border-b border-border")}>
              <View className="px-4 pt-4 pb-2 flex-row items-center gap-2">
                <Wrench size={16} className="text-foreground" />
                <Text className="text-sm font-semibold text-foreground">
                  Tools
                </Text>
              </View>
              <ScrollView
                className={cn(isLargeScreen && "flex-1")}
                showsVerticalScrollIndicator={false}
                scrollEnabled={isLargeScreen}
              >
                <View className="px-4 pb-4 gap-1">
                  {AGENT_TOOLS.map((tool) => {
                    const enabled = capabilities.includes(tool.id);
                    const Icon = TOOL_ICONS[tool.icon];
                    return (
                      <Pressable
                        key={tool.id}
                        onPress={() => toggleCapability(tool.id)}
                        className="flex-row items-center gap-3 py-1.5"
                      >
                        {Icon && <Icon size={15} className={enabled ? "text-foreground" : "text-muted-foreground"} />}
                        <Text className={cn("text-sm flex-1", enabled ? "text-foreground" : "text-muted-foreground")}>
                          {tool.name}
                        </Text>
                        <Switch
                          value={enabled}
                          onValueChange={() => toggleCapability(tool.id)}
                          size="sm"
                        />
                      </Pressable>
                    );
                  })}
                </View>
              </ScrollView>
            </View>

            {/* Knowledge (Library Files) */}
            <View className={cn(isLargeScreen && "flex-1")}>
              <View className="px-4 pt-4 pb-2 flex-row items-center justify-between">
                <View className="flex-row items-center gap-2">
                  <BookOpen size={16} className="text-foreground" />
                  <Text className="text-sm font-semibold text-foreground">
                    {t("agents.knowledge")}
                  </Text>
                </View>
                <Pressable
                  onPress={() => setShowKnowledgePicker(!showKnowledgePicker)}
                  className="active:opacity-70"
                >
                  <Plus size={16} className="text-muted-foreground" />
                </Pressable>
              </View>
              <ScrollView
                className={cn(isLargeScreen && "flex-1")}
                showsVerticalScrollIndicator={false}
                scrollEnabled={isLargeScreen}
              >
                <View className="px-4 pb-4 gap-2">
                  {linkedKnowledge.map((file) => (
                    <View
                      key={file._id}
                      className="flex-row items-center justify-between py-1.5"
                    >
                      <View className="flex-row items-center gap-2 flex-1">
                        <FileText size={14} className="text-muted-foreground" />
                        <Text className="text-sm text-foreground flex-1" numberOfLines={1}>
                          {file.name}
                        </Text>
                      </View>
                      <Pressable
                        onPress={() => removeLinkedKnowledge(file._id)}
                        className="active:opacity-70 ml-2"
                      >
                        <X size={14} className="text-muted-foreground" />
                      </Pressable>
                    </View>
                  ))}
                </View>
              </ScrollView>
              <Dialog open={showKnowledgePicker} onOpenChange={setShowKnowledgePicker}>
                <DialogContent overlayClassName={cn(!isLargeScreen && "px-0")} className={cn("p-0 gap-0", !isLargeScreen && "flex-1 max-w-none rounded-none border-0")}>
                  <DialogHeader className="px-4 pt-4 pb-2">
                    <DialogTitle>{t("agents.knowledge")}</DialogTitle>
                  </DialogHeader>
                  <View className="mx-4 mb-2 flex-row items-center gap-2 px-3 py-1.5 border border-border rounded-md">
                    <Search size={14} className="text-muted-foreground" />
                    <TextInput
                      value={knowledgeSearch}
                      onChangeText={setKnowledgeSearch}
                      placeholder="Search library..."
                      placeholderTextColor={colors.mutedForeground}
                      className="flex-1 text-sm text-foreground"
                      autoFocus
                    />
                  </View>
                  <ScrollView style={{ maxHeight: isLargeScreen ? 300 : undefined }} className={cn(!isLargeScreen && "flex-1")}>
                    {libraryFiles
                      .filter((f) =>
                        !linkedKnowledge.some((lk) => lk._id === f._id) &&
                        (!knowledgeSearch || f.name.toLowerCase().includes(knowledgeSearch.toLowerCase()))
                      )
                      .map((file) => (
                        <Pressable
                          key={file._id}
                          onPress={() => addLinkedKnowledge({
                            _id: file._id,
                            name: file.name,
                            type: file.type,
                            category: file.category,
                            url: file.url,
                          })}
                          className="flex-row items-center gap-2 px-4 py-2 active:bg-muted"
                        >
                          <FileText size={14} className="text-muted-foreground" />
                          <Text className="text-sm text-foreground flex-1" numberOfLines={1}>
                            {file.name}
                          </Text>
                        </Pressable>
                      ))}
                    {libraryFiles.length === 0 && (
                      <Text className="text-xs text-muted-foreground px-4 py-3 text-center">
                        No files in library. Upload files on the Library screen.
                      </Text>
                    )}
                  </ScrollView>
                </DialogContent>
              </Dialog>
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
              className="text-foreground"
              style={{
                fontSize: 24,
                fontWeight: "700",
                flex: 1,
                padding: 0,
              }}
            />
          </View>

          {/* System Prompt / Instructions */}
          <Textarea
            variant="ghost"
            value={systemPrompt}
            onChangeText={setSystemPrompt}
            placeholder={t("agents.systemPromptPlaceholder")}
            placeholderTextColor={colors.mutedForeground}
            style={{ fontSize: 15, lineHeight: 22, minHeight: 300 }}
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
