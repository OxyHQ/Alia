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
import { AgentGlyph } from "@/components/ui/agent-glyph";
import { ColorPicker } from "@/components/ui/color-picker";
import { AGENT_SWATCHES } from "@/lib/constants/agent-colors";
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
import * as DropdownMenu from "@/components/ui/dropdown-menu";

// eslint-disable-next-line @typescript-eslint/no-var-requires
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
import { AgentCapabilityToggles } from "@/components/agent-capability-toggles";
import { AgentConnectorGrants } from "@/components/agent-connector-grants";
import type { GrantableConnector } from "@/lib/constants/capability-families";
import { useAgentBots, type AgentBot } from "@/lib/hooks/use-agent-bots";
import { errorMessage as getErrorMessage, errorStatus } from "@/lib/errors/error-utils";
import { ContentPanel } from "@oxyhq/bloom/content-panel";
import { useOxy } from "@oxyhq/services";

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

/**
 * One toast for the whole screen's autosave, reused rather than stacked.
 *
 * The autosave is debounced at a second and fires on every field change, so a
 * toast per save is a toast per pause while somebody writes a prompt — dozens,
 * piling up. Passing the same id replaces the previous one instead, which is
 * what makes the toast an INDICATOR rather than a log.
 *
 * Errors deliberately do NOT carry it. Two saves can be in flight at once (the
 * name goes to Oxy while the tagline goes to Alia), and under a shared id a
 * success arriving second would paint over a failure — which is the exact
 * silence `agents.saveFailed` was added to break.
 */
const SAVE_TOAST_ID = 'agent-editor-save';

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
  const [color, setColor] = useState<string | null>(null);
  const [tagline, setTagline] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [category, setCategory] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  /**
   * Every grant this agent holds: `web`, `mcp:<id>`, and the rest.
   *
   * ONE list for both shapes, because the API stores one — the families render
   * as toggles and the connectors as their own section, but a grant is a grant
   * and splitting the state would need a join on every save.
   */
  const [capabilityGrants, setCapabilityGrants] = useState<string[]>([]);
  /** The connectors this owner could grant. Empty until the fetch lands. */
  const [connectors, setConnectors] = useState<GrantableConnector[]>([]);
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
  /** The colour Oxy already holds, so a save only carries one that CHANGED. */
  const savedColor = useRef<string | null>(null);
  const [isPublished, setIsPublished] = useState(false);
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
        setColor(agent.color);
        savedColor.current = agent.color;
        setTagline(agent.tagline);
        setDescription(agent.description);
        setSystemPrompt(agent.systemPrompt || "");
        setCategory(agent.category);
        setTags(agent.tags || []);
        setCapabilityGrants(agent.capabilityGrants || []);
        setLinkedSkills(agent.skills || []);
        setLinkedKnowledge(agent.knowledge || []);
        setPrice(agent.price != null ? String(agent.price) : "");
        setAllowHiring(agent.allowHiring);
        setHandlesAutonomousEvents(agent.handlesAutonomousEvents);
        setIsPublished(agent.isPublished);
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

  /**
   * Debounced auto-save — and a FAILED save is now visible.
   *
   * This used to be `} catch { // silent }` with the spinner cleared in
   * `finally`, and the store swallowed the error before it too. Under those two
   * swallows every autosave this screen sent was a 400 — `permissions` against
   * a `.strict()` schema that did not name it — on every keystroke, for as long
   * as the screen existed. Nothing was saved: not the prompt, not the tagline,
   * not the skills. The UI said "saved" the whole time.
   *
   * One toast per failed save, not per keystroke: the debounce already
   * collapses a burst of typing into one request, so this fires as often as a
   * save does.
   */
  const debouncedSave = useCallback(
    (updates: AgentUpdate) => {
      if (!id || isInitialLoad.current) return;
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(async () => {
        toast.loading(t("agents.saving"), { id: SAVE_TOAST_ID });
        try {
          await updateAgent(id, updates);
          toast.success(t("agents.autoSaved"), { id: SAVE_TOAST_ID });
        } catch (error: unknown) {
          // The pending indicator goes first: left under its id it would sit
          // there spinning next to the failure it is contradicting.
          toast.dismiss(SAVE_TOAST_ID);
          toast.error(getErrorMessage(error, t("agents.saveFailed")));
        }
      }, 1000);
    },
    [id, updateAgent, t]
  );

  /**
   * The connectors this owner can grant, from the one endpoint that knows all
   * three instanced families.
   *
   * Fetched once for the screen rather than per section: MCP connectors, Oxy
   * apps and integrations are three different tables and this is the only place
   * that joins them into grant strings. A failure leaves the section empty —
   * the rest of the editor does not depend on it.
   */
  useEffect(() => {
    apiClient
      .get<{ connectors: GrantableConnector[] }>(API_ROUTES.agents.capabilityConnectors)
      .then((res) => setConnectors(res.data.connectors ?? []))
      .catch(() => setConnectors([]));
  }, []);

  /**
   * The NAME, the HANDLE and the COLOUR are saved to Oxy; everything else to Alia.
   *
   * Two writes, two services, two timers — not one call that fans out, because
   * a failed rename must not take the tagline with it and a failed tagline must
   * not roll back a rename. `updateAccount` sweeps Oxy's own identity caches,
   * so the profile surfaces do not serve the old name for a TTL afterwards.
   *
   * The colour belongs on this side of that split for the same reason the name
   * does: it is the agent's identity, it lives in `User.color` on the bot
   * account, and Alia stores no column for it.
   */
  useEffect(() => {
    if (oxyAccountId === "" || isInitialLoad.current) return;
    if (identityTimeoutRef.current) clearTimeout(identityTimeoutRef.current);
    identityTimeoutRef.current = setTimeout(async () => {
      toast.loading(t("agents.saving"), { id: SAVE_TOAST_ID });
      const trimmed = handle.trim();
      const handleChanged = trimmed !== savedHandle.current && trimmed !== "";

      /**
       * Ask Oxy whether the handle is free BEFORE writing it.
       *
       * On the same one-second debounce the save already uses, and only when the
       * handle actually CHANGED — the condition the write itself applies. One
       * question per pause, never one per keystroke, and none at all while
       * somebody is editing the name.
       *
       * This is UX, not correctness. Between this answer and the write there is
       * a window in which somebody else can take the name, so the AUTHORITY
       * stays where it was: the 409 below. A design that trusted this instead
       * would be a check-then-insert with a friendlier name.
       *
       * Which is also why a failure here is not a refusal. If Oxy cannot answer,
       * the save goes ahead and the server decides — degrading to "I don't know"
       * is right, degrading to "you may not" is not.
       */
      if (handleChanged) {
        /**
         * An unanswerable check reads as "free", so the save goes ahead and the
         * server decides. Measured against Oxy answering 500: the SDK retries
         * four times with backoff, and the write lands about nine seconds later
         * carrying the username — the degradation is correct, and slow, and the
         * pending toast sits there for those nine seconds.
         *
         * `try`/`await` rather than `.catch()` on the promise. Both were
         * measured and behave identically here, because the SDK rejects rather
         * than throwing; this form is the one that would also survive a version
         * that throws.
         */
        let free = true;
        try {
          free = (await oxyServices.checkUsernameAvailability(trimmed)).available;
        } catch {
          free = true;
        }

        if (!free) {
          toast.dismiss(SAVE_TOAST_ID);
          setHandle(savedHandle.current);
          toast.error(t("agents.handleTaken"));
          return;
        }
      }

      try {
        await oxyServices.updateAccount(oxyAccountId, {
          name: { displayName: name },
          // Only when it actually changed: `username` is globally unique, and
          // re-sending the current one on every keystroke of the NAME field
          // would ask Oxy to re-check a handle nobody touched.
          ...(handleChanged && { username: trimmed }),
          // Same rule as the handle, for a different reason: `color` is
          // absent-means-unchanged on `UpdateAccountInput`, so sending the
          // current one on every keystroke of the NAME field would write a
          // value nobody touched.
          ...(color !== savedColor.current && color !== null && { color }),
        });
        savedHandle.current = trimmed;
        savedColor.current = color;
        toast.success(t("agents.autoSaved"), { id: SAVE_TOAST_ID });
      } catch (error: unknown) {
        toast.dismiss(SAVE_TOAST_ID);
        // A taken handle is the one failure worth saying out loud: the field
        // still shows what the person typed, and without this it silently
        // reverts on the next load with nothing to explain it.
        //
        // Still here, and still the authority. The check above only makes the
        // answer arrive sooner and more often; it cannot make this unreachable,
        // because the name can be taken in the moment between the two.
        if (errorStatus(error) === 409) {
          setHandle(savedHandle.current);
          toast.error(t("agents.handleTaken"));
        } else {
          // This used to stay silent, on the reasoning that an autosave raising
          // a toast per keystroke-shaped failure is worse than one that does
          // not. The pending state is a toast now, so silence stopped being
          // neutral: the "Saving…" would simply vanish, which reads as saved.
          toast.error(getErrorMessage(error, t("agents.saveFailed")));
        }
      }
    }, 1000);
    return () => {
      if (identityTimeoutRef.current) clearTimeout(identityTimeoutRef.current);
    };
    /**
     * `t` is not a dependency, and no longer needs to be excluded for safety —
     * it is memoised on the locale now. It stays out because a language change
     * is not a reason to write to Oxy: the only thing this uses it for is a
     * failure message, and `i18n.t` reads the locale when it is called.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, handle, color, oxyAccountId, oxyServices]);

  // Auto-save on field changes
  useEffect(() => {
    debouncedSave({
      tagline,
      description,
      systemPrompt,
      category,
      tags,
      capabilityGrants,
      skills: linkedSkills.map((s) => s._id),
      knowledge: linkedKnowledge.map((k) => k._id),
      price: price.trim() ? parseFloat(price) : null,
      allowHiring,
      handlesAutonomousEvents,
      archetype,
      archetypeConfig,
    });
  }, [
    tagline,
    description,
    systemPrompt,
    category,
    tags,
    capabilityGrants,
    linkedSkills,
    linkedKnowledge,
    price,
    allowHiring,
    handlesAutonomousEvents,
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

            {/* Capabilities — ONE list. It was two, "Tools" and "Permissions",
                which overlapped on four concepts and disagreed on all four. */}
            <AgentCapabilityToggles
              title={t("agents.capabilities")}
              footer={t("agents.capabilitiesFooter")}
              grants={capabilityGrants}
              onChange={setCapabilityGrants}
            />

            {/* Connectors, granted one at a time — see the component. */}
            <AgentConnectorGrants
              connectors={connectors}
              grants={capabilityGrants}
              onChange={setCapabilityGrants}
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
            {/* Mark + Name + Handle — all three are the bot ACCOUNT's, saved
                to Oxy rather than to the agent row. */}
            <View className="flex-row items-center gap-3 mb-6">
              <AgentGlyph size={40} color={color} />
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

            {/* The colour is the agent's whole likeness, so the picker offers
                the MARK rather than a dot standing for one. Only the colours
                Oxy will STORE: this offered all sixty-one of Bloom's free
                presets, and the fifty-two the `users_color_check` constraint
                omits were a 400 on a swatch the person had just picked. */}
            <View className="mb-6">
              <ColorPicker
                colors={AGENT_SWATCHES}
                selected={color ?? ""}
                onSelect={setColor}
                label={t("agents.colorLabel")}
                renderSwatch={(preset) => <AgentGlyph size={28} color={preset} />}
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

                {/* No "Knowledge Sources" picker. It wrote four hardcoded names
                    — `github`, `notion`, `linear`, `google_calendar` — into
                    `archetypeConfig.knowledgeSources`, the third of the three
                    capability vocabularies, and its only consumer spliced them
                    into the Q&A prompt as PROSE. It named sources the agent
                    might never have been able to reach, and two of the four are
                    not integrations any more at all. What an agent can actually
                    reach is the Connectors section above. */}

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
