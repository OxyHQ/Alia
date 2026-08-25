import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  View,
  ScrollView,
  Pressable,
  TextInput,
} from "react-native";
import { useIsLargeScreen } from "@/lib/hooks/use-is-large-screen";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarImage } from "@/components/ui/avatar";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Panel } from "@/components/ui/panel";
import { Dialog } from "@oxyhq/bloom/dialog";
import {
  ArrowLeft,
  X,
  Plus,
  Ellipsis,
  Settings,
  ChevronRight,
  Search as SearchIcon,
  FileText,
  Globe,
  Terminal,
  FileDown,
  FolderOpen,
  Image,
  Brain,
  Users,
  Send,
  Trash2,
} from "lucide-react-native";
import { Search } from "@oxyhq/bloom/search";
import { GhostButton } from "@oxyhq/bloom/button";
import { Item } from "@oxyhq/bloom/item";
import { SettingsListGroup, SettingsListItem } from "@oxyhq/bloom/settings-list";
import { AGENT_TOOLS } from "@/lib/constants/agent-tools";
import * as DropdownMenu from "@/components/ui/dropdown-menu";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const DEFAULT_AVATAR = require("@/assets/images/agent-avatar-reference.png");
import { useRouter, useLocalSearchParams } from "expo-router";
import { useAgentsStore, type Agent, type AgentUpdate, type AgentArchetype, type ArchetypeConfig, type RoutingRule } from "@/lib/stores/agents-store";
import { useTranslation } from "@/lib/hooks/use-translation";
import { useColorScheme } from "@/lib/useColorScheme";
import { toast } from "@oxyhq/bloom/toast";
import { confirm } from "@oxyhq/bloom/surfaces";
import { cn } from "@/lib/utils";
import apiClient from "@/lib/api/client";
import { API_ROUTES } from "@/lib/api/routes";
import { useLibraryStore, type LibraryFile } from "@/lib/stores/library-store";
import { AgentPermissionToggles, DEFAULT_PERMISSIONS } from "@/components/agent-permission-toggles";
import type { AgentPermissions } from "@/lib/stores/agents-store";
import { useAgentBots, type AgentBot } from "@/lib/hooks/use-agent-bots";
import { errorStatus } from "@/lib/errors/error-utils";
import { ContentPanel } from "@oxyhq/bloom/content-panel";
import { useOxy } from "@oxyhq/services";

const TOOL_ICONS: Record<string, React.ComponentType<{ size?: number; color?: string; className?: string }>> = {
  Globe, Terminal, Search: SearchIcon, FileDown, FolderOpen, Image, Brain, Users,
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
  const isLargeScreen = useIsLargeScreen();
  // The agent's NAME lives on its Oxy bot account, so the editor writes it there.
  const { oxyServices } = useOxy();
  const getAgent = useAgentsStore((state) => state.getAgent);
  const updateAgent = useAgentsStore((state) => state.updateAgent);
  const deleteAgent = useAgentsStore((state) => state.deleteAgent);

  // Loading
  const [loading, setLoading] = useState(true);

  // Form state
  const [name, setName] = useState("");
  /**
   * The Oxy `bot` account this agent IS.
   *
   * The name below is written to THAT account, not to the agent row: Alia
   * stores no name any more, and `PATCH /agents/:id` refuses one outright. An
   * empty string means the agent has not loaded yet, which is why the identity
   * save below refuses to run on one.
   */
  const [oxyAccountId, setOxyAccountId] = useState("");
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
  const [handlesAutonomousEvents, setHandlesAutonomousEvents] = useState(false);
  /**
   * The agent's HANDLE — its Oxy username, editable after creation.
   *
   * `POST /agents/generate` proposes one and `POST /accounts` resolves a
   * collision by appending a suffix, so the person can land here with a name
   * they did not choose. `PATCH /accounts/:id` accepts `username`, so it is
   * shown and editable rather than permanent.
   */
  const [handle, setHandle] = useState("");
  /** What Oxy last confirmed, so a rejected rename can be put back. */
  const savedHandle = useRef("");
  const [isPublished, setIsPublished] = useState(false);
  const [permissions, setPermissions] = useState<AgentPermissions>(DEFAULT_PERMISSIONS);
  const [archetype, setArchetype] = useState<AgentArchetype>('general');
  const [archetypeConfig, setArchetypeConfig] = useState<ArchetypeConfig>({});

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

  // Telegram bot binding for this agent
  const { bots: agentBots, registerBot, removeBot } = useAgentBots(id);
  const [showBotDialog, setShowBotDialog] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [connectingBot, setConnectingBot] = useState(false);

  // Auto-save debounce
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** The identity save has its own timer: it targets a different service. */
  const identityTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
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
        setName(agent.name ?? "");
        setHandle(agent.handle ?? "");
        savedHandle.current = agent.handle ?? "";
        setOxyAccountId(agent.oxyAccountId);
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
        setHandlesAutonomousEvents(agent.handlesAutonomousEvents);
        setIsPublished(agent.isPublished);
        if (agent.permissions) setPermissions({ ...DEFAULT_PERMISSIONS, ...agent.permissions });
        setArchetype(agent.archetype || 'general');
        setArchetypeConfig(agent.archetypeConfig || {});
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
    (updates: AgentUpdate) => {
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

  /**
   * The NAME is saved to Oxy, and everything else to Alia.
   *
   * Two writes, two services, two timers — not one call that fans out, because
   * a failed rename must not take the tagline with it and a failed tagline must
   * not roll back a rename. `updateAccount` sweeps Oxy's own identity caches,
   * so the profile surfaces do not serve the old name for a TTL afterwards.
   */
  useEffect(() => {
    if (oxyAccountId === "" || isInitialLoad.current) return;
    if (identityTimeoutRef.current) clearTimeout(identityTimeoutRef.current);
    identityTimeoutRef.current = setTimeout(async () => {
      setSaving(true);
      const trimmed = handle.trim();
      try {
        await oxyServices.updateAccount(oxyAccountId, {
          name: { displayName: name },
          // Only when it actually changed: `username` is globally unique, and
          // re-sending the current one on every keystroke of the NAME field
          // would ask Oxy to re-check a handle nobody touched.
          ...(trimmed !== savedHandle.current && trimmed !== "" && { username: trimmed }),
        });
        savedHandle.current = trimmed;
      } catch (error: unknown) {
        // A taken handle is the one failure worth saying out loud: the field
        // still shows what the person typed, and without this it silently
        // reverts on the next load with nothing to explain it.
        if (errorStatus(error) === 409) {
          setHandle(savedHandle.current);
          toast.error(t("agents.handleTaken"));
        }
        // Everything else stays silent, as the Alia save beside it is: an
        // autosave raising a toast on every keystroke-shaped failure is worse
        // than one that does not.
      } finally {
        setSaving(false);
      }
    }, 1000);
    return () => {
      if (identityTimeoutRef.current) clearTimeout(identityTimeoutRef.current);
    };
  }, [name, handle, oxyAccountId, oxyServices, t]);

  // Auto-save on field changes
  useEffect(() => {
    debouncedSave({
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
      handlesAutonomousEvents,
      permissions,
      archetype,
      archetypeConfig,
    });
  }, [
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
    handlesAutonomousEvents,
    permissions,
    archetype,
    archetypeConfig,
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

  const handleDelete = useCallback(async () => {
    if (!id) return;
    const ok = await confirm({
      title: t("agents.deleteAgent"),
      description: t("agents.deleteAgentConfirm"),
      confirmLabel: t("agents.deleteAgent"),
      cancelLabel: "Cancel",
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteAgent(id);
      toast.success(t("agents.agentDeleted"));
      router.back();
    } catch {
      toast.error("Failed to delete agent");
    }
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

  const handleConnectBot = useCallback(async () => {
    const token = botToken.trim();
    if (!token || connectingBot) return;
    setConnectingBot(true);
    try {
      await registerBot(token);
      toast.success(t("agents.telegramBot.connected"));
      setBotToken("");
      setShowBotDialog(false);
    } catch (err) {
      const status = errorStatus(err);
      if (status === 409) {
        toast.error(t("agents.telegramBot.errorAlreadyRegistered"));
      } else if (status === 400) {
        toast.error(t("agents.telegramBot.errorInvalidToken"));
      } else {
        toast.error(t("agents.telegramBot.errorGeneric"));
      }
    } finally {
      setConnectingBot(false);
    }
  }, [botToken, connectingBot, registerBot, t]);

  const handleRemoveBot = useCallback(
    async (bot: AgentBot) => {
      const ok = await confirm({
        title: t("agents.telegramBot.removeTitle"),
        description: t("agents.telegramBot.removeDescription"),
        confirmLabel: t("agents.telegramBot.remove"),
        cancelLabel: t("common.cancel"),
        destructive: true,
      });
      if (!ok) return;
      try {
        await removeBot(bot._id);
        toast.success(t("agents.telegramBot.removed"));
      } catch {
        toast.error(t("agents.telegramBot.errorGeneric"));
      }
    },
    [removeBot, t]
  );

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
        /* The resources tab is one scrolling column of grouped sections;
           the settings tab keeps its fixed-height layout on large screens. */
        scrollEnabled={sidebarTab === "resources" || !isLargeScreen}
        contentContainerStyle={
          sidebarTab === "settings" && isLargeScreen ? { flex: 1 } : undefined
        }
      >
        {sidebarTab === "resources" ? (
          <View className="px-4 pt-4">
            {/* Skills */}
            <SettingsListGroup title={t("agents.skills")}>
              {linkedSkills.map((skill) => (
                <SettingsListItem
                  key={skill._id}
                  icon={<Text className="text-base">{skill.icon}</Text>}
                  title={skill.title}
                  rightElement={
                    <GhostButton
                      size="small"
                      accessibilityLabel={`${t("agents.removeSkill")}: ${skill.title}`}
                      onPress={() => removeLinkedSkill(skill._id)}
                      icon={<X size={14} className="text-muted-foreground" />}
                    />
                  }
                />
              ))}
              <SettingsListItem
                icon={<Plus size={18} className="text-muted-foreground" />}
                title={t("agents.addSkill")}
                onPress={() => setShowSkillPicker(true)}
                showChevron={false}
              />
            </SettingsListGroup>
            <Dialog
              open={showSkillPicker}
              onClose={() => setShowSkillPicker(false)}
              placement={{ base: "bottom", md: "center" }}
              title={t("agents.skills")}
              // The picker owns its own ScrollView and its own padding.
              scrollable={false}
              contentPadding={0}
            >
                <View className="mx-4 mb-2">
                  <Search
                    label="Search skills..."
                    value={skillSearch}
                    onChangeText={setSkillSearch}
                    onClearText={() => setSkillSearch("")}
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
                      <Item
                        key={skill._id}
                        onPress={() => addLinkedSkill(skill)}
                        leading={<Text className="text-base">{skill.icon}</Text>}
                        title={skill.title}
                      />
                    ))}
                </ScrollView>
            </Dialog>

            {/* Tools */}
            <SettingsListGroup title="Tools">
              {AGENT_TOOLS.map((tool) => {
                const enabled = capabilities.includes(tool.id);
                const Icon = TOOL_ICONS[tool.icon];
                return (
                  <SettingsListItem
                    key={tool.id}
                    icon={
                      Icon ? (
                        <Icon
                          size={18}
                          className={enabled ? "text-foreground" : "text-muted-foreground"}
                        />
                      ) : undefined
                    }
                    title={tool.name}
                    onPress={() => toggleCapability(tool.id)}
                    showChevron={false}
                    rightElement={
                      <Switch
                        value={enabled}
                        onValueChange={() => toggleCapability(tool.id)}
                        size="sm"
                      />
                    }
                  />
                );
              })}
            </SettingsListGroup>

            {/* Permissions */}
            <AgentPermissionToggles
              title="Permissions"
              permissions={permissions}
              onChange={setPermissions}
            />

            {/* Knowledge (Library Files) */}
            <SettingsListGroup title={t("agents.knowledge")}>
              {linkedKnowledge.map((file) => (
                <SettingsListItem
                  key={file._id}
                  icon={<FileText size={18} className="text-muted-foreground" />}
                  title={file.name}
                  rightElement={
                    <GhostButton
                      size="small"
                      accessibilityLabel={`${t("agents.removeKnowledge")}: ${file.name}`}
                      onPress={() => removeLinkedKnowledge(file._id)}
                      icon={<X size={14} className="text-muted-foreground" />}
                    />
                  }
                />
              ))}
              <SettingsListItem
                icon={<Plus size={18} className="text-muted-foreground" />}
                title={t("agents.addKnowledge")}
                onPress={() => setShowKnowledgePicker(true)}
                showChevron={false}
              />
            </SettingsListGroup>
            <Dialog
              open={showKnowledgePicker}
              onClose={() => setShowKnowledgePicker(false)}
              placement={{ base: "bottom", md: "center" }}
              title={t("agents.knowledge")}
              // The picker owns its own ScrollView and its own padding.
              scrollable={false}
              contentPadding={0}
            >
                <View className="mx-4 mb-2">
                  <Search
                    label="Search library..."
                    value={knowledgeSearch}
                    onChangeText={setKnowledgeSearch}
                    onClearText={() => setKnowledgeSearch("")}
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
                      <Item
                        key={file._id}
                        onPress={() => addLinkedKnowledge({
                          _id: file._id,
                          name: file.name,
                          type: file.type,
                          category: file.category,
                          url: file.url,
                        })}
                        leading={<FileText size={14} className="text-muted-foreground" />}
                        title={file.name}
                      />
                    ))}
                  {libraryFiles.length === 0 && (
                    <Text className="text-xs text-muted-foreground px-4 py-3 text-center">
                      No files in library. Upload files on the Library screen.
                    </Text>
                  )}
                </ScrollView>
            </Dialog>
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

            {/* Autonomous events — ONE agent per owner, enforced by the API. */}
            <View className="flex-row items-center justify-between">
              <View className="flex-1 pr-4">
                <Label>{t("agents.handlesAutonomousEvents")}</Label>
                <Text className="text-[13px] text-muted-foreground mt-0.5">
                  {t("agents.handlesAutonomousEventsHint")}
                </Text>
              </View>
              <Switch
                value={handlesAutonomousEvents}
                onValueChange={setHandlesAutonomousEvents}
              />
            </View>

            {/* Telegram bot */}
            <View className="gap-2 pt-2 border-t border-border">
              <View className="flex-row items-center gap-2 pt-2">
                <Send size={16} className="text-foreground" />
                <Text className="text-sm font-semibold text-foreground">
                  {t("agents.telegramBot.title")}
                </Text>
              </View>

              {agentBots.length === 0 ? (
                <Text className="text-xs text-muted-foreground">
                  {t("agents.telegramBot.empty")}
                </Text>
              ) : (
                <View className="gap-1">
                  {agentBots.map((bot) => (
                    <View
                      key={bot._id}
                      className="flex-row items-center gap-2 py-1.5"
                    >
                      <View
                        className="p-1.5 rounded-lg"
                        style={{ backgroundColor: "#0088CC15" }}
                      >
                        <Send size={14} color="#0088CC" />
                      </View>
                      <View className="flex-1 flex-row items-center gap-2">
                        <Text
                          className="text-sm text-foreground"
                          numberOfLines={1}
                        >
                          {bot.username ? `@${bot.username}` : bot.name}
                        </Text>
                        <View
                          className={cn(
                            "w-2 h-2 rounded-full",
                            bot.status === "active"
                              ? "bg-green-500"
                              : bot.status === "error"
                                ? "bg-red-500"
                                : "bg-gray-400"
                          )}
                        />
                      </View>
                      <Pressable
                        onPress={() => handleRemoveBot(bot)}
                        className="active:opacity-70 p-1"
                      >
                        <Trash2 size={14} className="text-muted-foreground" />
                      </Pressable>
                    </View>
                  ))}
                </View>
              )}

              <Button
                variant="outline"
                size="sm"
                className="self-start"
                onPress={() => setShowBotDialog(true)}
              >
                <View className="flex-row items-center gap-2">
                  <Plus size={14} className="text-foreground" />
                  <Text className="text-sm text-foreground">
                    {t("agents.telegramBot.connect")}
                  </Text>
                </View>
              </Button>
            </View>
          </View>
        )}
      </ScrollView>

      {/* Connect Telegram bot dialog */}
      <Dialog
        open={showBotDialog}
        onClose={() => setShowBotDialog(false)}
        placement={{ base: "bottom", md: "center" }}
        title={t("agents.telegramBot.dialogTitle")}
        description={t("agents.telegramBot.dialogDescription")}
        actions={[
          { label: t("common.cancel"), color: "cancel", disabled: connectingBot },
          {
            label: t("agents.telegramBot.connect"),
            onPress: handleConnectBot,
            disabled: connectingBot || !botToken.trim(),
            // The connect request is in flight when this runs.
            shouldCloseOnPress: false,
          },
        ]}
      >
          <View className="gap-1.5">
            <Label>{t("agents.telegramBot.tokenLabel")}</Label>
            <Input
              value={botToken}
              onChangeText={setBotToken}
              placeholder={t("agents.telegramBot.tokenPlaceholder")}
              placeholderTextColor={colors.mutedForeground}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
      </Dialog>
    </View>
  );

  return (
    <ContentPanel surfaceClassName="bg-background">
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
              {archetype !== 'general' && (
                <View className="px-2 py-0.5 rounded-full bg-blue-500/15">
                  <Text className="text-xs font-medium text-blue-500 capitalize">
                    {archetype.replace('_', ' ')}
                  </Text>
                </View>
              )}
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
            {/* Avatar + Name + Handle — all three are the bot ACCOUNT's, saved
                to Oxy rather than to the agent row. */}
            <View className="flex-row items-center gap-3 mb-6">
              <Avatar className="h-10 w-10">
                <AvatarImage
                  source={avatarUrl ? { uri: avatarUrl } : DEFAULT_AVATAR}
                />
              </Avatar>
              <View className="flex-1">
                <TextInput
                  value={name}
                  onChangeText={setName}
                  placeholder={t("agents.namePlaceholder")}
                  placeholderTextColor={colors.mutedForeground}
                  className="text-foreground"
                  style={{
                    fontSize: 24,
                    fontWeight: "700",
                    padding: 0,
                  }}
                />
                {/* The handle was PROPOSED at creation and may carry a
                    collision suffix nobody chose, so it is editable here
                    rather than permanent. */}
                <View className="flex-row items-center">
                  <Text className="text-[15px] text-muted-foreground">@</Text>
                  <TextInput
                    value={handle}
                    onChangeText={setHandle}
                    placeholder={t("agents.handlePlaceholder")}
                    placeholderTextColor={colors.mutedForeground}
                    autoCapitalize="none"
                    autoCorrect={false}
                    className="text-muted-foreground flex-1"
                    style={{ fontSize: 15, padding: 0 }}
                  />
                </View>
              </View>
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

            {/* Archetype-specific configuration */}
            {archetype === 'status_update' && (
              <View className="mt-6 gap-4">
                <Text className="text-lg font-semibold text-foreground">Report Configuration</Text>

                {/* Report Template */}
                <View className="gap-1.5">
                  <Label>Report Template</Label>
                  <Textarea
                    value={archetypeConfig.reportTemplate || ''}
                    onChangeText={(text) => setArchetypeConfig((prev: ArchetypeConfig) => ({ ...prev, reportTemplate: text }))}
                    placeholder="## Daily Standup\n### What happened\n### Key metrics\n### Action items"
                    placeholderTextColor={colors.mutedForeground}
                    style={{ minHeight: 120 }}
                  />
                </View>

                {/* Schedule */}
                <View className="gap-1.5">
                  <Label>Schedule</Label>
                  <View className="flex-row gap-2">
                    <ToggleGroup
                      type="single"
                      value={archetypeConfig.schedule?.type || 'daily'}
                      onValueChange={(val) => {
                        const type = val === 'interval' ? 'interval' : val === 'cron' ? 'cron' : 'daily';
                        setArchetypeConfig((prev: ArchetypeConfig) => ({
                          ...prev,
                          schedule: { ...prev.schedule, type },
                        }));
                      }}
                    >
                      <ToggleGroupItem value="daily">Daily</ToggleGroupItem>
                      <ToggleGroupItem value="interval">Interval</ToggleGroupItem>
                    </ToggleGroup>
                  </View>
                  {(archetypeConfig.schedule?.type || 'daily') === 'daily' && (
                    <Input
                      value={archetypeConfig.schedule?.time || '09:00'}
                      onChangeText={(text) => setArchetypeConfig((prev: ArchetypeConfig) => ({
                        ...prev,
                        schedule: { ...prev.schedule, type: prev.schedule?.type ?? 'daily', time: text }
                      }))}
                      placeholder="09:00"
                      placeholderTextColor={colors.mutedForeground}
                    />
                  )}
                </View>

                {/* Delivery Channels */}
                <View className="gap-1.5">
                  <Label>Delivery Channels</Label>
                  <View className="flex-row flex-wrap gap-2">
                    {['in_app', 'telegram', 'discord', 'slack', 'email'].map((channel) => {
                      const channels = archetypeConfig.deliveryChannels || [];
                      const isActive = channels.includes(channel);
                      return (
                        <Pressable
                          key={channel}
                          onPress={() => {
                            setArchetypeConfig((prev: ArchetypeConfig) => ({
                              ...prev,
                              deliveryChannels: isActive
                                ? channels.filter((c: string) => c !== channel)
                                : [...channels, channel]
                            }));
                          }}
                          className={cn(
                            "px-3 py-1.5 rounded-full border",
                            isActive ? "bg-primary/10 border-primary" : "border-border"
                          )}
                        >
                          <Text className={cn("text-xs font-medium capitalize", isActive ? "text-primary" : "text-muted-foreground")}>
                            {channel.replace('_', ' ')}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>

                {/* Compare with Previous */}
                <View className="flex-row items-center justify-between">
                  <Label>Compare with previous report</Label>
                  <Switch
                    value={archetypeConfig.compareWithPrevious || false}
                    onValueChange={(val) => setArchetypeConfig((prev: ArchetypeConfig) => ({ ...prev, compareWithPrevious: val }))}
                  />
                </View>
              </View>
            )}

            {archetype === 'qa' && (
              <View className="mt-6 gap-4">
                <Text className="text-lg font-semibold text-foreground">Q&A Configuration</Text>

                {/* Knowledge Sources - integrations */}
                <View className="gap-1.5">
                  <Label>Knowledge Sources</Label>
                  <View className="flex-row flex-wrap gap-2">
                    {['github', 'notion', 'linear', 'google_calendar'].map((integration) => {
                      const integrations = archetypeConfig.knowledgeSources?.integrations || [];
                      const isActive = integrations.includes(integration);
                      return (
                        <Pressable
                          key={integration}
                          onPress={() => {
                            const current = archetypeConfig.knowledgeSources?.integrations || [];
                            setArchetypeConfig((prev: ArchetypeConfig) => ({
                              ...prev,
                              knowledgeSources: {
                                ...prev.knowledgeSources,
                                integrations: isActive
                                  ? current.filter((i: string) => i !== integration)
                                  : [...current, integration]
                              }
                            }));
                          }}
                          className={cn(
                            "px-3 py-1.5 rounded-full border",
                            isActive ? "bg-primary/10 border-primary" : "border-border"
                          )}
                        >
                          <Text className={cn("text-xs font-medium capitalize", isActive ? "text-primary" : "text-muted-foreground")}>
                            {integration.replace('_', ' ')}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>

                {/* Cite Sources */}
                <View className="flex-row items-center justify-between">
                  <Label>Cite sources in answers</Label>
                  <Switch
                    value={archetypeConfig.citeSources !== false}
                    onValueChange={(val) => setArchetypeConfig((prev: ArchetypeConfig) => ({ ...prev, citeSources: val }))}
                  />
                </View>
              </View>
            )}

            {archetype === 'task_router' && (
              <View className="mt-6 gap-4">
                <Text className="text-lg font-semibold text-foreground">Routing Configuration</Text>

                {/* Inbound Channels */}
                <View className="gap-1.5">
                  <Label>Inbound Channels</Label>
                  <View className="flex-row flex-wrap gap-2">
                    {['email', 'slack', 'discord', 'webhook', 'github', 'linear'].map((channel) => {
                      const channels = archetypeConfig.inboundChannels || [];
                      const isActive = channels.includes(channel);
                      return (
                        <Pressable
                          key={channel}
                          onPress={() => {
                            setArchetypeConfig((prev: ArchetypeConfig) => ({
                              ...prev,
                              inboundChannels: isActive
                                ? channels.filter((c: string) => c !== channel)
                                : [...channels, channel]
                            }));
                          }}
                          className={cn(
                            "px-3 py-1.5 rounded-full border",
                            isActive ? "bg-primary/10 border-primary" : "border-border"
                          )}
                        >
                          <Text className={cn("text-xs font-medium capitalize", isActive ? "text-primary" : "text-muted-foreground")}>
                            {channel}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>

                {/* Routing Rules */}
                <View className="gap-2">
                  <View className="flex-row items-center justify-between">
                    <Label>Routing Rules</Label>
                    <Pressable
                      onPress={() => {
                        setArchetypeConfig((prev: ArchetypeConfig) => ({
                          ...prev,
                          routingRules: [...(prev.routingRules || []), { condition: '', priority: 'medium', assignTo: { type: 'user', id: '', name: '' } }]
                        }));
                      }}
                      className="active:opacity-70"
                    >
                      <Plus size={16} className="text-muted-foreground" />
                    </Pressable>
                  </View>
                  {(archetypeConfig.routingRules || []).map((rule, index) => (
                    <View key={index} className="rounded-xl bg-muted p-3 gap-2">
                      <Input
                        value={rule.condition}
                        onChangeText={(text) => {
                          const rules = [...(archetypeConfig.routingRules || [])];
                          rules[index] = { ...rules[index], condition: text };
                          setArchetypeConfig((prev: ArchetypeConfig) => ({ ...prev, routingRules: rules }));
                        }}
                        placeholder="When the task is about..."
                        placeholderTextColor={colors.mutedForeground}
                      />
                      <View className="flex-row gap-2 items-center">
                        <ToggleGroup
                          type="single"
                          value={rule.priority}
                          onValueChange={(val) => {
                            const priority = val === 'low' ? 'low' : val === 'high' ? 'high' : val === 'urgent' ? 'urgent' : 'medium';
                            const rules = [...(archetypeConfig.routingRules || [])];
                            rules[index] = { ...rules[index], priority };
                            setArchetypeConfig((prev: ArchetypeConfig) => ({ ...prev, routingRules: rules }));
                          }}
                        >
                          <ToggleGroupItem value="low">Low</ToggleGroupItem>
                          <ToggleGroupItem value="medium">Med</ToggleGroupItem>
                          <ToggleGroupItem value="high">High</ToggleGroupItem>
                          <ToggleGroupItem value="urgent">Urgent</ToggleGroupItem>
                        </ToggleGroup>
                        <Pressable
                          onPress={() => {
                            const rules = (archetypeConfig.routingRules || []).filter((_, i) => i !== index);
                            setArchetypeConfig((prev: ArchetypeConfig) => ({ ...prev, routingRules: rules }));
                          }}
                          className="active:opacity-70 ml-auto"
                        >
                          <X size={14} className="text-muted-foreground" />
                        </Pressable>
                      </View>
                      <Input
                        value={rule.assignTo?.name || ''}
                        onChangeText={(text) => {
                          const rules = [...(archetypeConfig.routingRules || [])];
                          rules[index] = { ...rules[index], assignTo: { ...rules[index].assignTo, name: text } };
                          setArchetypeConfig((prev: ArchetypeConfig) => ({ ...prev, routingRules: rules }));
                        }}
                        placeholder="Route to (name)"
                        placeholderTextColor={colors.mutedForeground}
                      />
                    </View>
                  ))}
                </View>

                {/* Escalation Timeout */}
                <View className="gap-1.5">
                  <Label>Escalation Timeout (minutes)</Label>
                  <Input
                    value={String(archetypeConfig.escalationTimeoutMinutes || '')}
                    onChangeText={(text) => {
                      const num = parseInt(text, 10);
                      setArchetypeConfig((prev: ArchetypeConfig) => ({ ...prev, escalationTimeoutMinutes: isNaN(num) ? undefined : num }));
                    }}
                    placeholder="60"
                    placeholderTextColor={colors.mutedForeground}
                    keyboardType="number-pad"
                  />
                </View>
              </View>
            )}
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
    </ContentPanel>
  );
}
