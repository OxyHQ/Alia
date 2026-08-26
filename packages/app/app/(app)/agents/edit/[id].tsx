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
import { IdentityMark } from "@alia.onl/sdk";
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
  FileText,
  Send,
  Trash2,
} from "lucide-react-native";
import { Search } from "@oxyhq/bloom/search";
import { GhostButton } from "@oxyhq/bloom/button";
import { Item } from "@oxyhq/bloom/item";
import { SettingsListGroup, SettingsListItem } from "@oxyhq/bloom/settings-list";
import * as DropdownMenu from "@/components/ui/dropdown-menu";

import { useRouter, useLocalSearchParams } from "expo-router";
import { useAgent, useUpdateAgent, useDeleteAgent } from "@/lib/hooks/use-agents";
import type { Agent, AgentArchetype, ArchetypeConfig } from "@/lib/types/agents";
import { useTranslation } from "@/lib/hooks/use-translation";
import { useColorScheme } from "@/lib/useColorScheme";
import { agentTint } from "@/lib/agents/agent-color";
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

type LinkedSkill = { _id: string; name: string; displayName: string; icon: string | null; color: string | null };
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

/** How long the editor waits after the last edit before it writes. */
const SAVE_DELAY_MS = 1000;

/**
 * The agent's own fields, as the editor holds them while they are being edited.
 *
 * A DRAFT, not a cache of the record: the moment somebody types, this and the
 * server's copy disagree, and the whole point of the screen is that this one
 * wins until it is written. Which is why nothing re-seeds it — see
 * {@link EditAgentScreen}.
 *
 * `price` is the string the field holds rather than the number the API takes:
 * `"12."` is a legitimate thing to be halfway through typing and is not a
 * number, so the parse happens at the boundary, once, in {@link saveDraft}.
 */
interface AgentDraft {
  tagline: string;
  description: string;
  systemPrompt: string;
  category: string;
  tags: string[];
  capabilityGrants: string[];
  skills: LinkedSkill[];
  knowledge: LinkedFile[];
  price: string;
  access: 'private' | 'public';
  handlesAutonomousEvents: boolean;
  archetype: AgentArchetype;
  archetypeConfig: ArchetypeConfig;
}

/**
 * The three fields that belong to the agent's Oxy bot ACCOUNT rather than to
 * its Alia row, so they are written to a different service by a different call.
 */
interface IdentityDraft {
  name: string;
  handle: string;
  color: string | null;
}

/**
 * The agent editor: load the agent, then hand it to a form that owns the draft.
 *
 * ## The split is what stopped the write loop
 *
 * There was one component, and it copied the fetched agent into eighteen
 * `useState`s from an effect that listed the fetched agent in its dependencies.
 * `useUpdateAgent` writes the mutation's answer into `agents.detail`, so every
 * save handed that effect a new record; re-seeding assigned fresh references
 * (`agent.skills || []`) to the very state a second effect watched in order to
 * decide to save; and that effect saved. **One keystroke wrote for as long as
 * the screen stayed open** — measured at a PATCH every two seconds, plus an
 * `updateAccount` to Oxy alongside it, each with its own toast. That is what
 * "no para de mostrar toasts que pone saving" was.
 *
 * A `key` on the form is the whole cure. The draft is seeded ONCE, from props,
 * in `useState` initialisers; a newer record arriving in the cache re-renders
 * this component and changes nothing inside the form. Two effects, a
 * `isInitialLoad` ref and a 500ms timer that existed only to stop the seeding
 * from tripping the saving all went with it.
 *
 * ## And a save is now an EDIT's consequence
 *
 * `editDraft` and `editIdentity` are the only ways the draft changes, and each
 * schedules its own write. Nothing observes state in order to write, so no
 * amount of re-rendering can produce a request — which is the property
 * `__tests__/autosave-writes-once.test.tsx` pins.
 */
export default function EditAgentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useTranslation();
  const { data: agent, isPending } = useAgent(id);

  if (isPending || agent === undefined) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <Text className="text-muted-foreground">{t("common.loading")}</Text>
      </View>
    );
  }

  // Keyed on the agent, so opening a DIFFERENT one starts a different draft
  // and opening the same one again never restarts this one.
  return <AgentEditor key={agent._id} agent={agent} />;
}

function AgentEditor({ agent }: { agent: Agent }) {
  const router = useRouter();
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const isLargeScreen = useIsLargeScreen();
  // The agent's NAME lives on its Oxy bot account, so the editor writes it there.
  const { oxyServices } = useOxy();
  const updateAgent = useUpdateAgent();
  const deleteAgent = useDeleteAgent();

  const [draft, setDraft] = useState<AgentDraft>(() => ({
    tagline: agent.tagline,
    description: agent.description,
    systemPrompt: agent.systemPrompt || "",
    category: agent.category,
    tags: agent.tags || [],
    capabilityGrants: agent.capabilityGrants || [],
    skills: agent.skills || [],
    knowledge: agent.knowledge || [],
    price: agent.price != null ? String(agent.price) : "",
    access: agent.access,
    handlesAutonomousEvents: agent.handlesAutonomousEvents,
    archetype: agent.archetype || 'general',
    archetypeConfig: agent.archetypeConfig || {},
  }));
  const [identity, setIdentity] = useState<IdentityDraft>(() => ({
    name: agent.name ?? "",
    handle: agent.handle ?? "",
    color: agent.color,
  }));
  const {
    tagline,
    description,
    systemPrompt,
    category,
    capabilityGrants,
    skills,
    knowledge,
    price,
    access,
    handlesAutonomousEvents,
    archetype,
    archetypeConfig,
  } = draft;

  /** What Oxy last confirmed, so a rejected rename can be put back. */
  const savedHandle = useRef(agent.handle ?? "");
  /** The colour Oxy already holds, so a save only carries one that CHANGED. */
  const savedColor = useRef(agent.color);

  const [isPublished, setIsPublished] = useState(agent.isPublished);

  // Pickers
  const [allSkills, setAllSkills] = useState<LinkedSkill[]>([]);
  const [showSkillPicker, setShowSkillPicker] = useState(false);
  const [skillSearch, setSkillSearch] = useState("");
  const [showKnowledgePicker, setShowKnowledgePicker] = useState(false);
  const [knowledgeSearch, setKnowledgeSearch] = useState("");
  /** The connectors this owner could grant. Empty until the fetch lands. */
  const [connectors, setConnectors] = useState<GrantableConnector[]>([]);

  // Library files for knowledge picker
  const libraryFiles = useLibraryStore((state) => state.files);
  const loadLibraryFiles = useLibraryStore((state) => state.loadFiles);

  // UI state
  const [showPanel, setShowPanel] = useState(isLargeScreen);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("resources");

  // Telegram bot binding for this agent
  const { bots: agentBots, registerBot, removeBot } = useAgentBots(agent._id);
  const [showBotDialog, setShowBotDialog] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [connectingBot, setConnectingBot] = useState(false);

  /**
   * The two debounce timers. Two, because the two halves of a save go to two
   * different services and a slow rename must not hold up a tagline.
   *
   * NOT cleared on unmount, deliberately: a save scheduled a moment before
   * somebody presses back is a save they asked for, and dropping it is how the
   * name edit used to get lost. Nothing in either callback touches component
   * state, so there is nothing to leak — only a request and a toast.
   */
  const draftSaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const identitySaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Skills an agent may be given: the public catalogue plus this account's own.
  // Attaching one is its own authorization — the agent's skills reach its
  // conversations whether or not the person also installed them.
  useEffect(() => {
    Promise.all([
      apiClient.get(API_ROUTES.skills.catalogue).then((res) => res.data.skills ?? []).catch(() => []),
      apiClient.get(API_ROUTES.skills.mine).then((res) => res.data.skills ?? []).catch(() => []),
    ]).then(([catalogue, mine]: [LinkedSkill[], LinkedSkill[]]) => {
      const byId = new Map<string, LinkedSkill>();
      for (const skill of [...catalogue, ...mine]) byId.set(skill._id, skill);
      setAllSkills([...byId.values()]);
    });
    loadLibraryFiles();
  }, [loadLibraryFiles]);

  /**
   * The rows this owner can grant, from the one endpoint that knows all four
   * instanced families.
   *
   * Fetched once for the screen rather than per section: MCP connectors, Oxy
   * apps, integrations and this owner's other agents are four different tables
   * and this is the only place that joins them into grant strings. A failure
   * leaves the section empty — the rest of the editor does not depend on it.
   *
   * The agent being edited goes with the request so the server can leave it out
   * of its own list.
   */
  useEffect(() => {
    apiClient
      .get<{ connectors: GrantableConnector[] }>(
        API_ROUTES.agents.capabilityConnectors(agent._id),
      )
      .then((res) => setConnectors(res.data.connectors ?? []))
      .catch(() => setConnectors([]));
  }, [agent._id]);

  /**
   * Write the draft, and say so.
   *
   * A FAILED save is visible. This used to be `} catch { // silent }` with the
   * store swallowing the error before it too, and under those two swallows
   * every autosave this screen sent was a 400 — `permissions` against a
   * `.strict()` schema that did not name it — on every keystroke. Nothing was
   * saved: not the prompt, not the tagline, not the skills. The UI said "saved"
   * the whole time.
   */
  const saveDraft = useCallback(
    async (next: AgentDraft): Promise<void> => {
      toast.loading(t("agents.saving"), { id: SAVE_TOAST_ID });
      try {
        await updateAgent.mutateAsync({
          id: agent._id,
          updates: {
            tagline: next.tagline,
            description: next.description,
            systemPrompt: next.systemPrompt,
            category: next.category,
            tags: next.tags,
            capabilityGrants: next.capabilityGrants,
            skills: next.skills.map((skill) => skill._id),
            knowledge: next.knowledge.map((file) => file._id),
            price: next.price.trim() ? parseFloat(next.price) : null,
            access: next.access,
            handlesAutonomousEvents: next.handlesAutonomousEvents,
            archetype: next.archetype,
            archetypeConfig: next.archetypeConfig,
          },
        });
        toast.success(t("agents.autoSaved"), { id: SAVE_TOAST_ID });
      } catch (error: unknown) {
        // The pending indicator goes first: left under its id it would sit
        // there spinning next to the failure it is contradicting.
        toast.dismiss(SAVE_TOAST_ID);
        toast.error(getErrorMessage(error, t("agents.saveFailed")));
      }
    },
    [agent._id, updateAgent.mutateAsync, t]
  );

  /**
   * The NAME, the HANDLE and the COLOUR are saved to Oxy; everything else to Alia.
   *
   * Two writes, two services — not one call that fans out, because a failed
   * rename must not take the tagline with it and a failed tagline must not roll
   * back a rename. `updateAccount` sweeps Oxy's own identity caches, so the
   * profile surfaces do not serve the old name for a TTL afterwards.
   *
   * The colour belongs on this side of that split for the same reason the name
   * does: it is the agent's identity, it lives in `User.color` on the bot
   * account, and Alia stores no column for it.
   */
  const saveIdentity = useCallback(
    async (next: IdentityDraft): Promise<void> => {
      toast.loading(t("agents.saving"), { id: SAVE_TOAST_ID });
      const trimmed = next.handle.trim();
      const handleChanged = trimmed !== savedHandle.current && trimmed !== "";

      /**
       * Ask Oxy whether the handle is free BEFORE writing it, and only when the
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
          // A rollback, so it goes through `setIdentity` rather than
          // `editIdentity`: putting the old handle back is not an edit and must
          // not schedule a write of its own.
          setIdentity((prev) => ({ ...prev, handle: savedHandle.current }));
          toast.error(t("agents.handleTaken"));
          return;
        }
      }

      try {
        await oxyServices.updateAccount(agent.oxyAccountId, {
          name: { displayName: next.name },
          // Only when it actually changed: `username` is globally unique, and
          // re-sending the current one on every keystroke of the NAME field
          // would ask Oxy to re-check a handle nobody touched.
          ...(handleChanged && { username: trimmed }),
          // Same rule as the handle, for a different reason: `color` is
          // absent-means-unchanged on `UpdateAccountInput`, so sending the
          // current one on every keystroke of the NAME field would write a
          // value nobody touched.
          ...(next.color !== savedColor.current && next.color !== null && { color: next.color }),
        });
        savedHandle.current = trimmed;
        savedColor.current = next.color;
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
          setIdentity((prev) => ({ ...prev, handle: savedHandle.current }));
          toast.error(t("agents.handleTaken"));
        } else {
          // This used to stay silent, on the reasoning that an autosave raising
          // a toast per keystroke-shaped failure is worse than one that does
          // not. The pending state is a toast now, so silence stopped being
          // neutral: the "Saving…" would simply vanish, which reads as saved.
          toast.error(getErrorMessage(error, t("agents.saveFailed")));
        }
      }
    },
    [agent.oxyAccountId, oxyServices, t]
  );

  /**
   * An edit, which is the ONLY thing that writes.
   *
   * The merged draft is computed here and handed to the timer, so the write
   * carries what was on screen when it was scheduled rather than reading state
   * back later. Re-scheduling is what collapses a burst of typing into one
   * request.
   */
  const editDraft = (patch: Partial<AgentDraft>): void => {
    const next = { ...draft, ...patch };
    setDraft(next);
    clearTimeout(draftSaveTimer.current);
    draftSaveTimer.current = setTimeout(() => { void saveDraft(next); }, SAVE_DELAY_MS);
  };

  const editIdentity = (patch: Partial<IdentityDraft>): void => {
    const next = { ...identity, ...patch };
    setIdentity(next);
    clearTimeout(identitySaveTimer.current);
    identitySaveTimer.current = setTimeout(() => { void saveIdentity(next); }, SAVE_DELAY_MS);
  };

  const handlePublishToggle = useCallback(async () => {
    const newValue = !isPublished;
    setIsPublished(newValue);
    try {
      await updateAgent.mutateAsync({ id: agent._id, updates: { isPublished: newValue } });
      toast.success(newValue ? t("agents.published") : t("agents.draft"));
    } catch {
      setIsPublished(!newValue);
      toast.error("Failed to update");
    }
  }, [agent._id, isPublished, updateAgent.mutateAsync, t]);

  const handleDelete = useCallback(async () => {
    const ok = await confirm({
      title: t("agents.deleteAgent"),
      description: t("agents.deleteAgentConfirm"),
      confirmLabel: t("agents.deleteAgent"),
      cancelLabel: "Cancel",
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteAgent.mutateAsync(agent._id);
      toast.success(t("agents.agentDeleted"));
      router.back();
    } catch {
      toast.error("Failed to delete agent");
    }
  }, [agent._id, deleteAgent.mutateAsync, router, t]);

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
              {skills.map((skill) => (
                <SettingsListItem
                  key={skill._id}
                  icon={<Text className="text-base">{skill.icon ?? '\u{1F9E9}'}</Text>}
                  title={skill.displayName}
                  rightElement={
                    <GhostButton
                      size="small"
                      accessibilityLabel={`${t("agents.removeSkill")}: ${skill.displayName}`}
                      onPress={() => editDraft({ skills: skills.filter((s) => s._id !== skill._id) })}
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
                      !skills.some((linked) => linked._id === s._id) &&
                      (!skillSearch ||
                        s.displayName.toLowerCase().includes(skillSearch.toLowerCase()) ||
                        s.name.includes(skillSearch.toLowerCase()))
                    )
                    .map((skill) => (
                      <Item
                        key={skill._id}
                        onPress={() => {
                          editDraft({ skills: [...skills, skill] });
                          setShowSkillPicker(false);
                          setSkillSearch("");
                        }}
                        leading={<Text className="text-base">{skill.icon ?? '\u{1F9E9}'}</Text>}
                        title={skill.displayName}
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
              onChange={(grants) => editDraft({ capabilityGrants: grants })}
            />

            {/* Connectors, granted one at a time — see the component. */}
            <AgentConnectorGrants
              connectors={connectors}
              grants={capabilityGrants}
              onChange={(grants) => editDraft({ capabilityGrants: grants })}
            />

            {/* Knowledge (Library Files) */}
            <SettingsListGroup title={t("agents.knowledge")}>
              {knowledge.map((file) => (
                <SettingsListItem
                  key={file._id}
                  icon={<FileText size={18} className="text-muted-foreground" />}
                  title={file.name}
                  rightElement={
                    <GhostButton
                      size="small"
                      accessibilityLabel={`${t("agents.removeKnowledge")}: ${file.name}`}
                      onPress={() => editDraft({ knowledge: knowledge.filter((k) => k._id !== file._id) })}
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
                      !knowledge.some((linked) => linked._id === f._id) &&
                      (!knowledgeSearch || f.name.toLowerCase().includes(knowledgeSearch.toLowerCase()))
                    )
                    .map((file) => (
                      <Item
                        key={file._id}
                        onPress={() => {
                          editDraft({
                            knowledge: [
                              ...knowledge,
                              {
                                _id: file._id,
                                name: file.name,
                                type: file.type,
                                category: file.category,
                                url: file.url,
                              },
                            ],
                          });
                          setShowKnowledgePicker(false);
                          setKnowledgeSearch("");
                        }}
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
                onValueChange={(val) => editDraft({ category: val as string })}
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
                onChangeText={(text) => editDraft({ tagline: text })}
                placeholder="Short description"
                placeholderTextColor={colors.mutedForeground}
              />
            </View>

            {/* Description */}
            <View className="gap-1.5">
              <Label>Description</Label>
              <Textarea
                value={description}
                onChangeText={(text) => editDraft({ description: text })}
                placeholder="Full description..."
                placeholderTextColor={colors.mutedForeground}
              />
            </View>

            {/* Price */}
            <View className="gap-1.5">
              <Label>Price per use (USD)</Label>
              <Input
                value={price}
                onChangeText={(text) => editDraft({ price: text })}
                placeholder="Free (leave empty)"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="decimal-pad"
              />
            </View>

            {/* Who may use it — a different question from whether it is listed. */}
            <View className="flex-row items-center justify-between">
              <View className="flex-1 pr-4">
                <Label>{t("agents.accessPublic")}</Label>
                <Text className="text-[13px] text-muted-foreground mt-0.5">
                  {t("agents.accessPublicHint")}
                </Text>
              </View>
              <Switch
                value={access === 'public'}
                onValueChange={(next) => editDraft({ access: next ? 'public' : 'private' })}
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
                onValueChange={(next) => editDraft({ handlesAutonomousEvents: next })}
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
              <IdentityMark size={40} color={agentTint(identity.color, colors)} />
              <View className="flex-1">
                <TextInput
                  value={identity.name}
                  onChangeText={(text) => editIdentity({ name: text })}
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
                    value={identity.handle}
                    onChangeText={(text) => editIdentity({ handle: text })}
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
                selected={identity.color ?? ""}
                onSelect={(preset) => editIdentity({ color: preset })}
                label={t("agents.colorLabel")}
                renderSwatch={(preset) => (
                  <IdentityMark size={28} color={agentTint(preset, colors)} />
                )}
              />
            </View>

            {/* System Prompt / Instructions */}
            <Textarea
              variant="ghost"
              value={systemPrompt}
              onChangeText={(text) => editDraft({ systemPrompt: text })}
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
                    onChangeText={(text) => editDraft({ archetypeConfig: { ...archetypeConfig, reportTemplate: text } })}
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
                        editDraft({ archetypeConfig: {
                          ...archetypeConfig,
                          schedule: { ...archetypeConfig.schedule, type }, } });
                      }}
                    >
                      <ToggleGroupItem value="daily">Daily</ToggleGroupItem>
                      <ToggleGroupItem value="interval">Interval</ToggleGroupItem>
                    </ToggleGroup>
                  </View>
                  {(archetypeConfig.schedule?.type || 'daily') === 'daily' && (
                    <Input
                      value={archetypeConfig.schedule?.time || '09:00'}
                      onChangeText={(text) => editDraft({ archetypeConfig: {
                        ...archetypeConfig,
                        schedule: { ...archetypeConfig.schedule, type: archetypeConfig.schedule?.type ?? 'daily', time: text } } })}
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
                            editDraft({ archetypeConfig: {
                              ...archetypeConfig,
                              deliveryChannels: isActive
                                ? channels.filter((c: string) => c !== channel)
                                : [...channels, channel] } });
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
                    onValueChange={(val) => editDraft({ archetypeConfig: { ...archetypeConfig, compareWithPrevious: val } })}
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
                    onValueChange={(val) => editDraft({ archetypeConfig: { ...archetypeConfig, citeSources: val } })}
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
                            editDraft({ archetypeConfig: {
                              ...archetypeConfig,
                              inboundChannels: isActive
                                ? channels.filter((c: string) => c !== channel)
                                : [...channels, channel] } });
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
                        editDraft({ archetypeConfig: {
                          ...archetypeConfig,
                          routingRules: [...(archetypeConfig.routingRules || []), { condition: '', priority: 'medium', assignTo: { type: 'user', id: '', name: '' } }] } });
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
                          editDraft({ archetypeConfig: { ...archetypeConfig, routingRules: rules } });
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
                            editDraft({ archetypeConfig: { ...archetypeConfig, routingRules: rules } });
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
                            editDraft({ archetypeConfig: { ...archetypeConfig, routingRules: rules } });
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
                          editDraft({ archetypeConfig: { ...archetypeConfig, routingRules: rules } });
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
                      editDraft({ archetypeConfig: { ...archetypeConfig, escalationTimeoutMinutes: isNaN(num) ? undefined : num } });
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
