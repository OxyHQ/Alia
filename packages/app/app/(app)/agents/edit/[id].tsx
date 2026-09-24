import { AgentCapabilityToggles } from '@/components/agent-capability-toggles';
import { AgentConnectorGrants } from '@/components/agent-connector-grants';
import { agentTint } from '@/lib/agents/agent-color';
import apiClient from '@/lib/api/client';
import { API_ROUTES } from '@/lib/api/routes';
import { AGENT_SWATCHES } from '@/lib/constants/agent-colors';
import type { GrantableConnector } from '@/lib/constants/capability-families';
import {
  errorStatus,
  errorMessage as getErrorMessage,
} from '@/lib/errors/error-utils';
import { useAgentBots, type AgentBot } from '@/lib/hooks/use-agent-bots';
import {
  useAgent,
  useDeleteAgent,
  useUpdateAgent,
} from '@/lib/hooks/use-agents';
import { useIsLargeScreen } from '@/lib/hooks/use-is-large-screen';
import { useTranslation } from '@/lib/hooks/use-translation';
import { useLibraryStore } from '@/lib/stores/library-store';
import type {
  Agent,
  AgentArchetype,
  ArchetypeConfig,
} from '@/lib/types/agents';
import { useColorScheme } from '@/lib/useColorScheme';
import { IdentityMark } from '@alia.onl/sdk';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { ButtonGroup, ButtonGroupItem } from '@oxy.so/bloom/button-group';
import { Card, CardBody } from '@oxy.so/bloom/card';
import { Chip, ChipRow } from '@oxy.so/bloom/chip';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Divider } from '@oxy.so/bloom/divider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@oxy.so/bloom/dropdown-menu';
import {
  RiAddLine,
  RiAtLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiFileTextLine,
  RiMore2Line,
  RiSendPlaneLine,
  RiSettings3Line,
} from '@oxy.so/bloom/icons';
import { Item } from '@oxy.so/bloom/item';
import { Label } from '@oxy.so/bloom/label';
import { Loading } from '@oxy.so/bloom/loading';
import { Search } from '@oxy.so/bloom/search';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import {
  SettingsListGroup,
  SettingsListItem,
} from '@oxy.so/bloom/settings-list';
import { confirm } from '@oxy.so/bloom/surfaces';
import { Switch } from '@oxy.so/bloom/switch';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import {
  TextField,
  TextFieldIcon,
  TextFieldInput as Input,
} from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import { toast } from '@oxy.so/bloom/toast';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useOxy } from '@oxy.so/services';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';

type LinkedSkill = {
  _id: string;
  name: string;
  displayName: string;
  icon: string | null;
  color: string | null;
};
type LinkedFile = {
  _id: string;
  name: string;
  type: string;
  category: string;
  url: string;
};

const CATEGORIES = [
  'Assistant',
  'Creative',
  'Developer',
  'Research',
  'Business',
  'Education',
];

type SidebarTab = 'resources' | 'settings';

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
  const router = useRouter();
  const { data: agent, isError, error, refetch } = useAgent(id);

  // Keyed on the agent, so opening a DIFFERENT one starts a different draft
  // and opening the same one again never restarts this one.
  if (agent !== undefined) {
    return <AgentEditor key={agent._id} agent={agent} />;
  }

  /**
   * A query that FAILED is not one that is loading.
   *
   * This screen used to render "Loading…" for `isPending || agent === undefined`,
   * and an errored query satisfies the second half forever — `isPending` is
   * false and `data` stays `undefined` — so a 404 was indistinguishable from a
   * fetch in flight and the screen never left it (#530). The two answers the
   * route gives are told apart here: a 404 is the route's deliberate "not
   * yours, or not there", which no retry changes, so the way out is the list;
   * anything else is transient and gets a Retry that runs the same query.
   */
  if (isError) {
    const notFound = errorStatus(error) === 404;
    return (
      <View className="flex-1 items-center justify-center gap-3 p-6">
        <Stack.Screen options={{ headerBackVisible: true }} />
        <Text className="text-center text-base font-semibold leading-[22px] text-foreground">
          {notFound ? t('agents.notFound') : t('agents.loadFailed')}
        </Text>
        <Muted className="text-center text-sm text-muted-foreground">
          {notFound
            ? t('agents.notFoundDetail')
            : getErrorMessage(error, t('agents.loadFailed'))}
        </Muted>
        {notFound ? (
          <Button
            tone="neutral"
            appearance="subtle"
            accessibilityRole="button"
            accessibilityLabel={t('agents.backToAgents')}
            onPress={() => router.replace('/(app)/agents')}
          >
            {t('agents.backToAgents')}
          </Button>
        ) : (
          <Button
            tone="neutral"
            appearance="subtle"
            accessibilityRole="button"
            accessibilityLabel={t('agents.retry')}
            onPress={() => void refetch()}
          >
            {t('agents.retry')}
          </Button>
        )}
      </View>
    );
  }

  // Either the session is still minting its token — the query is disabled
  // until it has — or the fetch is in flight. Both are a wait, and the same one
  // to the person looking at it.
  return (
    <View className="flex-1 items-center justify-center">
      <Stack.Screen options={{ headerBackVisible: true }} />
      <Loading variant="spinner" text={t('common.loading')} />
    </View>
  );
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
    systemPrompt: agent.systemPrompt || '',
    category: agent.category,
    tags: agent.tags || [],
    capabilityGrants: agent.capabilityGrants || [],
    skills: agent.skills || [],
    knowledge: agent.knowledge || [],
    price: agent.price != null ? String(agent.price) : '',
    access: agent.access,
    archetype: agent.archetype || 'general',
    archetypeConfig: agent.archetypeConfig || {},
  }));
  const [identity, setIdentity] = useState<IdentityDraft>(() => ({
    name: agent.name ?? '',
    handle: agent.handle ?? '',
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
    archetype,
    archetypeConfig,
  } = draft;

  /** What Oxy last confirmed, so a rejected rename can be put back. */
  const savedHandle = useRef(agent.handle ?? '');
  /** The colour Oxy already holds, so a save only carries one that CHANGED. */
  const savedColor = useRef(agent.color);

  const [isPublished, setIsPublished] = useState(agent.isPublished);

  // Pickers
  const [allSkills, setAllSkills] = useState<LinkedSkill[]>([]);
  const [showSkillPicker, setShowSkillPicker] = useState(false);
  const [skillSearch, setSkillSearch] = useState('');
  const [showKnowledgePicker, setShowKnowledgePicker] = useState(false);
  const [knowledgeSearch, setKnowledgeSearch] = useState('');
  /** The connectors this owner could grant. Empty until the fetch lands. */
  const [connectors, setConnectors] = useState<GrantableConnector[]>([]);

  // Library files for knowledge picker
  const libraryFiles = useLibraryStore((state) => state.files);
  const loadLibraryFiles = useLibraryStore((state) => state.loadFiles);

  // UI state
  const [showPanel, setShowPanel] = useState(isLargeScreen);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('resources');

  // Telegram bot binding for this agent
  const { bots: agentBots, registerBot, removeBot, setOwnerPaysAgentTurns } = useAgentBots(agent._id);
  const [showBotDialog, setShowBotDialog] = useState(false);
  const [botToken, setBotToken] = useState('');
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
      apiClient
        .get(API_ROUTES.skills.catalogue)
        .then((res) => res.data.skills ?? [])
        .catch(() => []),
      apiClient
        .get(API_ROUTES.skills.mine)
        .then((res) => res.data.skills ?? [])
        .catch(() => []),
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
      toast.loading(t('agents.saving'), { id: SAVE_TOAST_ID });
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
            archetype: next.archetype,
            archetypeConfig: next.archetypeConfig,
          },
        });
        toast.success(t('agents.autoSaved'), { id: SAVE_TOAST_ID });
      } catch (error: unknown) {
        // The pending indicator goes first: left under its id it would sit
        // there spinning next to the failure it is contradicting.
        toast.dismiss(SAVE_TOAST_ID);
        toast.error(getErrorMessage(error, t('agents.saveFailed')));
      }
    },
    [agent._id, updateAgent.mutateAsync, t],
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
      toast.loading(t('agents.saving'), { id: SAVE_TOAST_ID });
      const trimmed = next.handle.trim();
      const handleChanged = trimmed !== savedHandle.current && trimmed !== '';

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
          free = (await oxyServices.checkUsernameAvailability(trimmed))
            .available;
        } catch {
          free = true;
        }

        if (!free) {
          toast.dismiss(SAVE_TOAST_ID);
          // A rollback, so it goes through `setIdentity` rather than
          // `editIdentity`: putting the old handle back is not an edit and must
          // not schedule a write of its own.
          setIdentity((prev) => ({ ...prev, handle: savedHandle.current }));
          toast.error(t('agents.handleTaken'));
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
          ...(next.color !== savedColor.current &&
            next.color !== null && { color: next.color }),
        });
        savedHandle.current = trimmed;
        savedColor.current = next.color;
        toast.success(t('agents.autoSaved'), { id: SAVE_TOAST_ID });
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
          toast.error(t('agents.handleTaken'));
        } else {
          // This used to stay silent, on the reasoning that an autosave raising
          // a toast per keystroke-shaped failure is worse than one that does
          // not. The pending state is a toast now, so silence stopped being
          // neutral: the "Saving…" would simply vanish, which reads as saved.
          toast.error(getErrorMessage(error, t('agents.saveFailed')));
        }
      }
    },
    [agent.oxyAccountId, oxyServices, t],
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
    draftSaveTimer.current = setTimeout(() => {
      void saveDraft(next);
    }, SAVE_DELAY_MS);
  };

  const editIdentity = (patch: Partial<IdentityDraft>): void => {
    const next = { ...identity, ...patch };
    setIdentity(next);
    clearTimeout(identitySaveTimer.current);
    identitySaveTimer.current = setTimeout(() => {
      void saveIdentity(next);
    }, SAVE_DELAY_MS);
  };

  const handlePublishToggle = useCallback(async () => {
    const newValue = !isPublished;
    setIsPublished(newValue);
    try {
      await updateAgent.mutateAsync({
        id: agent._id,
        updates: { isPublished: newValue },
      });
      toast.success(newValue ? t('agents.published') : t('agents.draft'));
    } catch {
      setIsPublished(!newValue);
      toast.error('Failed to update');
    }
  }, [agent._id, isPublished, updateAgent.mutateAsync, t]);

  const handleDelete = useCallback(async () => {
    const ok = await confirm({
      title: t('agents.deleteAgent'),
      description: t('agents.deleteAgentConfirm'),
      confirmLabel: t('agents.deleteAgent'),
      cancelLabel: 'Cancel',
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteAgent.mutateAsync(agent._id);
      toast.success(t('agents.agentDeleted'));
      router.back();
    } catch {
      toast.error('Failed to delete agent');
    }
  }, [agent._id, deleteAgent.mutateAsync, router, t]);

  const handleConnectBot = useCallback(async () => {
    const token = botToken.trim();
    if (!token || connectingBot) return;
    setConnectingBot(true);
    try {
      await registerBot(token);
      toast.success(t('agents.telegramBot.connected'));
      setBotToken('');
      setShowBotDialog(false);
    } catch (err) {
      const status = errorStatus(err);
      if (status === 409) {
        toast.error(t('agents.telegramBot.errorAlreadyRegistered'));
      } else if (status === 400) {
        toast.error(t('agents.telegramBot.errorInvalidToken'));
      } else {
        toast.error(t('agents.telegramBot.errorGeneric'));
      }
    } finally {
      setConnectingBot(false);
    }
  }, [botToken, connectingBot, registerBot, t]);

  const handleOwnerPaysToggle = useCallback(
    async (bot: AgentBot, next: boolean) => {
      try {
        await setOwnerPaysAgentTurns(bot._id, next);
      } catch {
        toast.error(t("agents.telegramBot.errorGeneric"));
      }
    },
    [setOwnerPaysAgentTurns, t]
  );

  const handleRemoveBot = useCallback(
    async (bot: AgentBot) => {
      const ok = await confirm({
        title: t('agents.telegramBot.removeTitle'),
        description: t('agents.telegramBot.removeDescription'),
        confirmLabel: t('agents.telegramBot.remove'),
        cancelLabel: t('common.cancel'),
        destructive: true,
      });
      if (!ok) return;
      try {
        await removeBot(bot._id);
        toast.success(t('agents.telegramBot.removed'));
      } catch {
        toast.error(t('agents.telegramBot.errorGeneric'));
      }
    },
    [removeBot, t],
  );

  /** A routing rule's fields, rewritten into the draft as one edit. */
  const editRoutingRule = (
    index: number,
    patch: Partial<NonNullable<ArchetypeConfig['routingRules']>[number]>,
  ): void => {
    const rules = [...(archetypeConfig.routingRules || [])];
    rules[index] = { ...rules[index], ...patch };
    editDraft({ archetypeConfig: { ...archetypeConfig, routingRules: rules } });
  };

  /** One channel on or off in a multi-select list of the archetype config. */
  const toggleChannel = (
    key: 'deliveryChannels' | 'inboundChannels',
    channel: string,
  ): void => {
    const channels = archetypeConfig[key] || [];
    editDraft({
      archetypeConfig: {
        ...archetypeConfig,
        [key]: channels.includes(channel)
          ? channels.filter((c: string) => c !== channel)
          : [...channels, channel],
      },
    });
  };

  // The side column: resources and settings, switched by Bloom's tab strip.
  const sidebarContent = (
    <View className="flex-1">
      <Tabs
        value={sidebarTab}
        onValueChange={(next) => setSidebarTab(next as SidebarTab)}
        fullWidth
      >
        <TabsTrigger value="resources" label={t('agents.resources')} />
        <TabsTrigger value="settings" label={t('agents.settings')} />
      </Tabs>

      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-4 p-4"
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {sidebarTab === 'resources' ? (
          <>
            {/* Skills */}
            <SettingsListGroup title={t('agents.skills')}>
              {skills.map((skill) => (
                <SettingsListItem
                  key={skill._id}
                  icon={<Text>{skill.icon ?? '\u{1F9E9}'}</Text>}
                  title={skill.displayName}
                  rightElement={
                    <Button
                      size="xs"
                      tone="neutral"
                      appearance="plain"
                      icon={RiCloseLine}
                      accessibilityLabel={`${t('agents.removeSkill')}: ${skill.displayName}`}
                      onPress={() =>
                        editDraft({
                          skills: skills.filter((s) => s._id !== skill._id),
                        })
                      }
                    />
                  }
                />
              ))}
              <SettingsListItem
                icon={<RiAddLine size="md" />}
                title={t('agents.addSkill')}
                onPress={() => setShowSkillPicker(true)}
                showChevron={false}
              />
            </SettingsListGroup>
            <Dialog
              open={showSkillPicker}
              onClose={() => setShowSkillPicker(false)}
              placement={{ base: 'bottom', md: 'center' }}
              title={t('agents.skills')}
              // The picker owns its own ScrollView and its own padding.
              scrollable={false}
              contentPadding={0}
            >
              <View className="px-4 pb-2">
                <Search
                  label="Search skills..."
                  value={skillSearch}
                  onChangeText={setSkillSearch}
                  onClearText={() => setSkillSearch('')}
                  autoFocus
                />
              </View>
              <ScrollView
                className={isLargeScreen ? 'max-h-[300px]' : 'flex-1'}
              >
                {allSkills
                  .filter(
                    (s) =>
                      !skills.some((linked) => linked._id === s._id) &&
                      (!skillSearch ||
                        s.displayName
                          .toLowerCase()
                          .includes(skillSearch.toLowerCase()) ||
                        s.name.includes(skillSearch.toLowerCase())),
                  )
                  .map((skill) => (
                    <Item
                      key={skill._id}
                      role="option"
                      onPress={() => {
                        editDraft({ skills: [...skills, skill] });
                        setShowSkillPicker(false);
                        setSkillSearch('');
                      }}
                      leading={<Text>{skill.icon ?? '\u{1F9E9}'}</Text>}
                      title={skill.displayName}
                    />
                  ))}
              </ScrollView>
            </Dialog>

            {/* Capabilities — ONE list. It was two, "Tools" and "Permissions",
                which overlapped on four concepts and disagreed on all four. */}
            <AgentCapabilityToggles
              title={t('agents.capabilities')}
              footer={t('agents.capabilitiesFooter')}
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
            <SettingsListGroup title={t('agents.knowledge')}>
              {knowledge.map((file) => (
                <SettingsListItem
                  key={file._id}
                  icon={<RiFileTextLine size="md" />}
                  title={file.name}
                  rightElement={
                    <Button
                      size="xs"
                      tone="neutral"
                      appearance="plain"
                      icon={RiCloseLine}
                      accessibilityLabel={`${t('agents.removeKnowledge')}: ${file.name}`}
                      onPress={() =>
                        editDraft({
                          knowledge: knowledge.filter(
                            (k) => k._id !== file._id,
                          ),
                        })
                      }
                    />
                  }
                />
              ))}
              <SettingsListItem
                icon={<RiAddLine size="md" />}
                title={t('agents.addKnowledge')}
                onPress={() => setShowKnowledgePicker(true)}
                showChevron={false}
              />
            </SettingsListGroup>
            <Dialog
              open={showKnowledgePicker}
              onClose={() => setShowKnowledgePicker(false)}
              placement={{ base: 'bottom', md: 'center' }}
              title={t('agents.knowledge')}
              // The picker owns its own ScrollView and its own padding.
              scrollable={false}
              contentPadding={0}
            >
              <View className="px-4 pb-2">
                <Search
                  label="Search library..."
                  value={knowledgeSearch}
                  onChangeText={setKnowledgeSearch}
                  onClearText={() => setKnowledgeSearch('')}
                  autoFocus
                />
              </View>
              <ScrollView
                className={isLargeScreen ? 'max-h-[300px]' : 'flex-1'}
              >
                {libraryFiles
                  .filter(
                    (f) =>
                      !knowledge.some((linked) => linked._id === f._id) &&
                      (!knowledgeSearch ||
                        f.name
                          .toLowerCase()
                          .includes(knowledgeSearch.toLowerCase())),
                  )
                  .map((file) => (
                    <Item
                      key={file._id}
                      role="option"
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
                        setKnowledgeSearch('');
                      }}
                      leading={<RiFileTextLine size="sm" />}
                      title={file.name}
                    />
                  ))}
                {libraryFiles.length === 0 && (
                  <Muted className="p-4 text-center text-sm text-muted-foreground">
                    No files in library. Upload files on the Library screen.
                  </Muted>
                )}
              </ScrollView>
            </Dialog>
          </>
        ) : (
          <>
            {/* Category */}
            <View className="gap-1.5">
              <Label>Category</Label>
              <ChipRow role="radiogroup" accessibilityLabel="Category">
                {CATEGORIES.map((cat) => (
                  <Chip
                    key={cat}
                    size="xl"
                    role="radio"
                    selected={category === cat}
                    onPress={() => editDraft({ category: cat })}
                  >
                    {cat}
                  </Chip>
                ))}
              </ChipRow>
            </View>

            {/* Tagline */}
            <View className="gap-1.5">
              <Label>Tagline</Label>
              <Input
                label="Short description"
                value={tagline}
                onChangeText={(text) => editDraft({ tagline: text })}
                placeholder="Short description"
              />
            </View>

            {/* Description */}
            <View className="gap-1.5">
              <Label>Description</Label>
              <Textarea
                value={description}
                onChangeText={(text) => editDraft({ description: text })}
                placeholder="Full description..."
                autoResize
              />
            </View>

            {/* Price */}
            <View className="gap-1.5">
              <Label>Price per use (USD)</Label>
              <Input
                label="Free (leave empty)"
                value={price}
                onChangeText={(text) => editDraft({ price: text })}
                placeholder="Free (leave empty)"
                keyboardType="decimal-pad"
              />
            </View>

            {/* Who may use it — a different question from whether it is listed. */}
            <SettingsListGroup>
              <SettingsListItem
                title={t('agents.accessPublic')}
                description={t('agents.accessPublicHint')}
                rightElement={
                  <Switch
                    accessibilityLabel={t('agents.accessPublic')}
                    value={access === 'public'}
                    onValueChange={(next) =>
                      editDraft({ access: next ? 'public' : 'private' })
                    }
                  />
                }
              />
            </SettingsListGroup>

            {/* Telegram bot */}
            <SettingsListGroup
              title={t('agents.telegramBot.title')}
              footer={
                agentBots.length === 0
                  ? t('agents.telegramBot.empty')
                  : undefined
              }
            >
              {agentBots.map((bot) => (
                <Fragment key={bot._id}>
                <SettingsListItem
                  icon={<RiSendPlaneLine size="md" />}
                  title={bot.username ? `@${bot.username}` : bot.name}
                  rightElement={
                    <View className="flex-row items-center gap-2">
                      <Badge
                        dot
                        color={
                          bot.status === 'active'
                            ? 'success'
                            : bot.status === 'error'
                              ? 'error'
                              : 'default'
                        }
                      />
                      <Button
                        size="xs"
                        tone="neutral"
                        appearance="plain"
                        icon={RiDeleteBinLine}
                        accessibilityLabel={t('agents.telegramBot.remove')}
                        onPress={() => handleRemoveBot(bot)}
                      />
                    </View>
                  }
                />
                {/* Who pays when the agent's own balance runs out. */}
                <SettingsListItem
                  title={t('agents.telegramBot.ownerPaysLabel')}
                  description={t('agents.telegramBot.ownerPaysHint')}
                  rightElement={
                    <Switch
                      accessibilityLabel={t('agents.telegramBot.ownerPaysLabel')}
                      value={bot.ownerPaysAgentTurns === true}
                      onValueChange={(next) => handleOwnerPaysToggle(bot, next)}
                    />
                  }
                />
                </Fragment>
              ))}
              <SettingsListItem
                icon={<RiAddLine size="md" />}
                title={t('agents.telegramBot.connect')}
                onPress={() => setShowBotDialog(true)}
                showChevron={false}
              />
            </SettingsListGroup>
          </>
        )}
      </ScrollView>

      {/* Connect Telegram bot dialog */}
      <Dialog
        open={showBotDialog}
        onClose={() => setShowBotDialog(false)}
        placement={{ base: 'bottom', md: 'center' }}
        title={t('agents.telegramBot.dialogTitle')}
        description={t('agents.telegramBot.dialogDescription')}
        actions={[
          {
            label: t('common.cancel'),
            color: 'cancel',
            disabled: connectingBot,
          },
          {
            label: t('agents.telegramBot.connect'),
            onPress: handleConnectBot,
            disabled: connectingBot || !botToken.trim(),
            // The connect request is in flight when this runs.
            shouldCloseOnPress: false,
          },
        ]}
      >
        <View className="gap-1.5">
          <Label>{t('agents.telegramBot.tokenLabel')}</Label>
          <Input
            label={t('agents.telegramBot.tokenPlaceholder')}
            value={botToken}
            onChangeText={setBotToken}
            placeholder={t('agents.telegramBot.tokenPlaceholder')}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
      </Dialog>
    </View>
  );

  return (
    <View className="flex-1 flex-row">
      {/* Main column */}
      <View className="flex-1">
        <Stack.Screen
          options={{
            title: t('agents.instructions'),
            headerBackVisible: true,
            headerRight: () => (
              <>
                <ButtonGroup
                  accessibilityLabel={t('pages.agents.agentActions')}
                >
                  {!isLargeScreen && (
                    <ButtonGroupItem
                      iconOnly
                      leadingIcon={RiSettings3Line}
                      accessibilityLabel={t('agents.settings')}
                      onPress={() => setShowPanel(true)}
                    />
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger label="Actions" asChild>
                      <ButtonGroupItem
                        iconOnly
                        leadingIcon={RiMore2Line}
                        accessibilityLabel={t('pages.agents.moreActions')}
                      />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem
                        key="delete"
                        onPress={handleDelete}
                        leading={<RiDeleteBinLine size="sm" />}
                      >
                        {t('agents.deleteAgent')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </ButtonGroup>
                <Button size="md" tone="action" onPress={handlePublishToggle}>
                  {isPublished ? t('agents.unpublish') : t('agents.publish')}
                </Button>
              </>
            ),
          }}
        />

        {/* Main editor */}
        <ScrollView
          className="flex-1"
          contentContainerClassName="gap-6 p-4 pb-[60px]"
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Where the agent stands: published or a draft, and its kind. */}
          <View className="flex-row flex-wrap items-center gap-2">
            <Badge
              size="label-small"
              variant="subtle"
              color={isPublished ? 'success' : 'default'}
              content={isPublished ? t('agents.published') : t('agents.draft')}
            />
            {archetype !== 'general' && (
              <Badge
                size="label-small"
                variant="subtle"
                color="info"
                content={archetype.replace('_', ' ')}
              />
            )}
          </View>

          {/* Mark + Name + Handle — all three are the bot ACCOUNT's, saved
              to Oxy rather than to the agent row. The handle was PROPOSED at
              creation and may carry a collision suffix nobody chose, so it is
              editable here rather than permanent. */}
          <View className="flex-row items-center gap-3">
            <IdentityMark size={48} color={agentTint(identity.color, colors)} />
            <View className="flex-1 gap-2">
              <Input
                label={t('agents.namePlaceholder')}
                value={identity.name}
                onChangeText={(text) => editIdentity({ name: text })}
              />
              <TextField>
                <TextFieldIcon icon={RiAtLine} />
                <Input
                  label={t('agents.handlePlaceholder')}
                  value={identity.handle}
                  onChangeText={(text) => editIdentity({ handle: text })}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </TextField>
            </View>
          </View>

          {/* The colour is the agent's whole likeness, so each choice shows
              the MARK rather than a dot standing for one. Only the colours Oxy
              will STORE: the fifty-two presets the `users_color_check`
              constraint omits were a 400 on a swatch the person had just
              picked. */}
          <View className="gap-1.5">
            <Label>{t('agents.colorLabel')}</Label>
            <ChipRow
              role="radiogroup"
              accessibilityLabel={t('agents.colorLabel')}
            >
              {AGENT_SWATCHES.map((preset) => (
                <Chip
                  key={preset}
                  size="xl"
                  role="radio"
                  selected={identity.color === preset}
                  onPress={() => editIdentity({ color: preset })}
                  startIcon={
                    <IdentityMark size={18} color={agentTint(preset, colors)} />
                  }
                >
                  {preset}
                </Chip>
              ))}
            </ChipRow>
          </View>

          {/* System prompt / instructions: the page-sized writing surface. */}
          <Textarea
            testID="agent-system-prompt"
            accessibilityLabel={t('agents.systemPromptPlaceholder')}
            value={systemPrompt}
            onChangeText={(text) => editDraft({ systemPrompt: text })}
            placeholder={t('agents.systemPromptPlaceholder')}
            rows={14}
            autoResize
          />

          {/* Archetype-specific configuration */}
          {archetype === 'status_update' && (
            <View className="gap-4">
              <Text variant="headline-semibold">Report Configuration</Text>

              {/* Report Template */}
              <View className="gap-1.5">
                <Label>Report Template</Label>
                <Textarea
                  value={archetypeConfig.reportTemplate || ''}
                  onChangeText={(text) =>
                    editDraft({
                      archetypeConfig: {
                        ...archetypeConfig,
                        reportTemplate: text,
                      },
                    })
                  }
                  placeholder="## Daily Standup\n### What happened\n### Key metrics\n### Action items"
                  autoResize
                  rows={6}
                />
              </View>

              {/* Schedule */}
              <View className="gap-1.5">
                <Label>Schedule</Label>
                <View className="self-start">
                  <SegmentedControl
                    label="Schedule"
                    type="radio"
                    value={archetypeConfig.schedule?.type || 'daily'}
                    onValueChange={(val) => {
                      const type =
                        val === 'interval'
                          ? 'interval'
                          : val === 'cron'
                            ? 'cron'
                            : 'daily';
                      editDraft({
                        archetypeConfig: {
                          ...archetypeConfig,
                          schedule: { ...archetypeConfig.schedule, type },
                        },
                      });
                    }}
                  >
                    <SegmentedControlItem value="daily">
                      <SegmentedControlItemText>Daily</SegmentedControlItemText>
                    </SegmentedControlItem>
                    <SegmentedControlItem value="interval">
                      <SegmentedControlItemText>
                        Interval
                      </SegmentedControlItemText>
                    </SegmentedControlItem>
                  </SegmentedControl>
                </View>
                {(archetypeConfig.schedule?.type || 'daily') === 'daily' && (
                  <Input
                    label="09:00"
                    value={archetypeConfig.schedule?.time || '09:00'}
                    onChangeText={(text) =>
                      editDraft({
                        archetypeConfig: {
                          ...archetypeConfig,
                          schedule: {
                            ...archetypeConfig.schedule,
                            type: archetypeConfig.schedule?.type ?? 'daily',
                            time: text,
                          },
                        },
                      })
                    }
                    placeholder="09:00"
                  />
                )}
              </View>

              {/* Delivery Channels */}
              <View className="gap-1.5">
                <Label>Delivery Channels</Label>
                <View className="flex-row flex-wrap gap-2">
                  {['in_app', 'telegram', 'discord', 'slack', 'email'].map(
                    (channel) => (
                      <Chip
                        key={channel}
                        size="xl"
                        selected={(
                          archetypeConfig.deliveryChannels || []
                        ).includes(channel)}
                        onPress={() =>
                          toggleChannel('deliveryChannels', channel)
                        }
                      >
                        {channel.replace('_', ' ')}
                      </Chip>
                    ),
                  )}
                </View>
              </View>

              {/* Compare with Previous */}
              <SettingsListGroup>
                <SettingsListItem
                  title="Compare with previous report"
                  rightElement={
                    <Switch
                      accessibilityLabel="Compare with previous report"
                      value={archetypeConfig.compareWithPrevious || false}
                      onValueChange={(val) =>
                        editDraft({
                          archetypeConfig: {
                            ...archetypeConfig,
                            compareWithPrevious: val,
                          },
                        })
                      }
                    />
                  }
                />
              </SettingsListGroup>
            </View>
          )}

          {archetype === 'qa' && (
            <View className="gap-4">
              <Text variant="headline-semibold">Q&A Configuration</Text>

              {/* No "Knowledge Sources" picker. It wrote four hardcoded names
                  into `archetypeConfig.knowledgeSources`, the third of the
                  three capability vocabularies, and its only consumer spliced
                  them into the Q&A prompt as PROSE. What an agent can actually
                  reach is the Connectors section. */}

              {/* Cite Sources */}
              <SettingsListGroup>
                <SettingsListItem
                  title="Cite sources in answers"
                  rightElement={
                    <Switch
                      accessibilityLabel="Cite sources in answers"
                      value={archetypeConfig.citeSources !== false}
                      onValueChange={(val) =>
                        editDraft({
                          archetypeConfig: {
                            ...archetypeConfig,
                            citeSources: val,
                          },
                        })
                      }
                    />
                  }
                />
              </SettingsListGroup>
            </View>
          )}

          {archetype === 'task_router' && (
            <View className="gap-4">
              <Text variant="headline-semibold">Routing Configuration</Text>

              {/* Inbound Channels */}
              <View className="gap-1.5">
                <Label>Inbound Channels</Label>
                <View className="flex-row flex-wrap gap-2">
                  {[
                    'email',
                    'slack',
                    'discord',
                    'webhook',
                    'github',
                    'linear',
                  ].map((channel) => (
                    <Chip
                      key={channel}
                      size="xl"
                      selected={(
                        archetypeConfig.inboundChannels || []
                      ).includes(channel)}
                      onPress={() => toggleChannel('inboundChannels', channel)}
                    >
                      {channel}
                    </Chip>
                  ))}
                </View>
              </View>

              {/* Routing Rules */}
              <View className="gap-2">
                <View className="flex-row items-center justify-between">
                  <Label>Routing Rules</Label>
                  <Button
                    size="xs"
                    tone="neutral"
                    appearance="plain"
                    icon={RiAddLine}
                    accessibilityLabel={t('pages.agents.addRoutingRule')}
                    onPress={() => {
                      editDraft({
                        archetypeConfig: {
                          ...archetypeConfig,
                          routingRules: [
                            ...(archetypeConfig.routingRules || []),
                            {
                              condition: '',
                              priority: 'medium',
                              assignTo: { type: 'user', id: '', name: '' },
                            },
                          ],
                        },
                      });
                    }}
                  />
                </View>
                {(archetypeConfig.routingRules || []).map((rule, index) => (
                  <Card key={index} appearance="subtle">
                    <CardBody>
                      <View className="gap-2 py-1">
                        <Input
                          label="When the task is about..."
                          value={rule.condition}
                          onChangeText={(text) =>
                            editRoutingRule(index, { condition: text })
                          }
                          placeholder="When the task is about..."
                        />
                        <View className="flex-row items-center gap-2">
                          <SegmentedControl
                            label="Priority"
                            type="radio"
                            size="sm"
                            value={rule.priority}
                            onValueChange={(val) => {
                              const priority =
                                val === 'low'
                                  ? 'low'
                                  : val === 'high'
                                    ? 'high'
                                    : val === 'urgent'
                                      ? 'urgent'
                                      : 'medium';
                              editRoutingRule(index, { priority });
                            }}
                          >
                            <SegmentedControlItem value="low">
                              <SegmentedControlItemText>
                                Low
                              </SegmentedControlItemText>
                            </SegmentedControlItem>
                            <SegmentedControlItem value="medium">
                              <SegmentedControlItemText>
                                Med
                              </SegmentedControlItemText>
                            </SegmentedControlItem>
                            <SegmentedControlItem value="high">
                              <SegmentedControlItemText>
                                High
                              </SegmentedControlItemText>
                            </SegmentedControlItem>
                            <SegmentedControlItem value="urgent">
                              <SegmentedControlItemText>
                                Urgent
                              </SegmentedControlItemText>
                            </SegmentedControlItem>
                          </SegmentedControl>
                          <View className="flex-1" />
                          <Button
                            size="xs"
                            tone="neutral"
                            appearance="plain"
                            icon={RiCloseLine}
                            accessibilityLabel={t(
                              'pages.agents.removeRoutingRule',
                            )}
                            onPress={() => {
                              const rules = (
                                archetypeConfig.routingRules || []
                              ).filter((_, i) => i !== index);
                              editDraft({
                                archetypeConfig: {
                                  ...archetypeConfig,
                                  routingRules: rules,
                                },
                              });
                            }}
                          />
                        </View>
                        <Input
                          label="Route to (name)"
                          value={rule.assignTo?.name || ''}
                          onChangeText={(text) =>
                            editRoutingRule(index, {
                              assignTo: { ...rule.assignTo, name: text },
                            })
                          }
                          placeholder="Route to (name)"
                        />
                      </View>
                    </CardBody>
                  </Card>
                ))}
              </View>

              {/* Escalation Timeout */}
              <View className="gap-1.5">
                <Label>Escalation Timeout (minutes)</Label>
                <Input
                  label="60"
                  value={String(archetypeConfig.escalationTimeoutMinutes || '')}
                  onChangeText={(text) => {
                    const num = parseInt(text, 10);
                    editDraft({
                      archetypeConfig: {
                        ...archetypeConfig,
                        escalationTimeoutMinutes: isNaN(num) ? undefined : num,
                      },
                    });
                  }}
                  placeholder="60"
                  keyboardType="number-pad"
                />
              </View>
            </View>
          )}
        </ScrollView>
      </View>

      {/* The side column — inline from the large breakpoint, a side sheet below it. */}
      {isLargeScreen ? (
        <>
          <Divider vertical />
          <View className="w-[320px]">{sidebarContent}</View>
        </>
      ) : (
        <Dialog
          open={showPanel}
          onClose={() => setShowPanel(false)}
          placement="right"
          width={320}
          title={t('agents.settings')}
          contentPadding={0}
          scrollable={false}
        >
          {sidebarContent}
        </Dialog>
      )}
    </View>
  );
}
