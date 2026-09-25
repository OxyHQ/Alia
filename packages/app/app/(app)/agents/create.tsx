import { Composer } from '@/components/chat/composer/composer';
import { useAliaComposer } from '@/components/chat/composer/use-alia-composer';
import {
  applyBotUsernameSuffix,
  createBotAccount,
} from '@/lib/agents/bot-account';
import apiClient from '@/lib/api/client';
import { API_ROUTES } from '@/lib/api/routes';
import { errorMessage as getErrorMessage } from '@/lib/errors/error-utils';
import { useCreateAgent } from '@/lib/hooks/use-agents';
import { useTranslation } from '@/lib/hooks/use-translation';
import type { BloomIconComponent } from '@oxy.so/bloom/icons';
import { RiBarChartHorizontalLine } from '@oxy.so/bloom/icons/RiBarChartHorizontalLine';
import { RiCheckLine } from '@oxy.so/bloom/icons/RiCheckLine';
import { RiQuestionLine } from '@oxy.so/bloom/icons/RiQuestionLine';
import { RiRouteLine } from '@oxy.so/bloom/icons/RiRouteLine';
import { RiSparklingLine } from '@oxy.so/bloom/icons/RiSparklingLine';
import { Item } from '@oxy.so/bloom/item';
import { Loading } from '@oxy.so/bloom/loading';
import { toast } from '@oxy.so/bloom/toast';
import { Muted, Text } from '@oxy.so/bloom/typography';
import {
  SELECTABLE_ACCOUNT_CATEGORY_IDS,
  type AccountCategoryId,
} from '@oxy.so/core';
import { useOxy } from '@oxy.so/services';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, View } from 'react-native';
type Archetype = 'general' | 'qa' | 'task_router' | 'status_update';

interface ArchetypeOption {
  value: Archetype;
  label: string;
  description: string;
  Icon: BloomIconComponent;
}

/** Whether a value IS one of Oxy's offered categories. See the note at the call site. */
function isOfferedAccountCategory(value: unknown): value is AccountCategoryId {
  return typeof value === 'string'
    && (SELECTABLE_ACCOUNT_CATEGORY_IDS as readonly string[]).includes(value);
}

const ARCHETYPE_OPTIONS: ArchetypeOption[] = [
  {
    value: 'general',
    label: 'General',
    description: 'Build any custom agent',
    Icon: RiSparklingLine,
  },
  {
    value: 'qa',
    label: 'Q&A',
    description: 'Answers questions from your knowledge',
    Icon: RiQuestionLine,
  },
  {
    value: 'task_router',
    label: 'Task Router',
    description: 'Triages and routes incoming tasks',
    Icon: RiRouteLine,
  },
  {
    value: 'status_update',
    label: 'Status Update',
    description: 'Generates scheduled reports',
    Icon: RiBarChartHorizontalLine,
  },
];

export default function CreateAgentScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const createAgent = useCreateAgent();
  const { createAccount, oxyServices } = useOxy();

  const [inputValue, setInputValue] = useState("");
  const [generating, setGenerating] = useState(false);
  /**
   * The model the new agent answers with: the composer's own picker, kept for
   * this screen rather than the app's chat choice. `null` is the server's
   * default, which is what the agent gets unless someone picks one here.
   */
  const [modelId, setModelId] = useState<string | null>(null);
  const composer = useAliaComposer({ locked: generating, selectedModel: modelId, onModelChange: setModelId });
  const [selectedArchetype, setSelectedArchetype] = useState<Archetype>('general');

  const handleGenerate = useCallback(async () => {
    if (!inputValue.trim() || generating) return;
    setGenerating(true);

    try {
      // Step 1: AI generates agent config from prompt. `suggestedUsername` is a
      // PROPOSAL — Oxy owns the handle namespace and resolves collisions.
      const genRes = await apiClient.post(API_ROUTES.agents.generate, {
        prompt: inputValue.trim(),
      });
      const config = genRes.data;

      /**
       * Step 2: mint the agent's IDENTITY at Oxy — a `bot` account under the
       * signed-in person's own tree, which makes them its owner.
       *
       * This is where the agent's name and handle now live. Alia never sees
       * them again except by reading them back.
       *
       * There is no avatar step. An agent's likeness is the `IdentityMark`
       * Alia herself wears, drawn in the account's own `User.color` — a field
       * `createAccount` cannot carry, so a new agent starts out drawn in the
       * theme's color and stays that way until Oxy can set one.
       */
      const account = await createBotAccount({
        createAccount,
        username: config.suggestedUsername,
        /**
         * Ask before minting, so a taken suggestion becomes a free handle the
         * person is TOLD about below — rather than the silent rename they used
         * to discover afterwards, when `community-maestro` had quietly become
         * `community-maestro1`.
         */
        checkAvailability: async (candidate) =>
          (await oxyServices.checkUsernameAvailability(candidate)).available,
        displayName: config.name,
        bio: config.tagline,
        /**
         * Only when the taxonomy recognises it. The generate route validated
         * this already, and it is checked again here for a reason that is not
         * distrust: `genRes.data` is `any`, so without a narrowing the union
         * `CreateAccountInput` declares would be satisfied by a claim rather
         * than by a check.
         *
         * MEMBERSHIP, not `isSelectableAccountCategoryId` — that one asks "is
         * this id still offered" against a retired list that is empty today, so
         * it answers true for anything at all, `undefined` included.
         *
         * Nothing fitting is a valid agent, so absent travels as absent. An
         * empty array would mean "clear them", which is a different request.
         */
        ...(isOfferedAccountCategory(config.accountCategory)
          ? { accountCategories: [config.accountCategory] }
          : {}),
        // This screen builds a DRAFT (`isPublished: false` below), so the
        // account is minted undiscoverable to match: kept out of Oxy's global
        // people search from the moment it exists, rather than listed there
        // under its owner's name until they publish it.
        private: true,
      });

      // Step 3: create the RUNTIME, bound to that account.
      const agent = await createAgent.mutateAsync({
        oxyAccountId: account.accountId,
        tagline: config.tagline,
        description: config.description,
        category: config.category,
        tags: config.tags,
        capabilityGrants: config.capabilityGrants,
        systemPrompt: config.systemPrompt,
        modelId,
        isPublished: false,
        archetype: config.archetype || selectedArchetype,
      });

      /**
       * Say which handle it got, and only when it is not the one proposed.
       *
       * Informative, never blocking: the account exists either way, and the
       * screen this navigates to is the agent editor, which has a handle
       * field. So the person reads what they were given and is already
       * standing where they can change it.
       */
      const granted = account.account.username;
      // Against the LABELLED suggestion, because a bot's handle ends in `bot`
      // and that label is added at the mint. Comparing against the bare
      // suggestion would announce an adjustment on every single create, which
      // is how a message that means something becomes one nobody reads.
      if (granted !== undefined && granted !== applyBotUsernameSuffix(config.suggestedUsername)) {
        toast.info(t("agents.handleAdjusted", { handle: granted }));
      } else {
        toast.success(t("agents.agentUpdated"));
      }
      router.replace({ pathname: "/(app)/agents/edit/[id]", params: { id: agent._id } });
      // No `else` for a null agent any more: the mutation THROWS a refusal
      // rather than returning null, so a failed create lands in the catch below
      // with the server's own message instead of a swallowed "Failed to create".
    } catch (error: unknown) {
      const message =
        getErrorMessage(error, "Failed to generate agent");
      toast.error(message);
    } finally {
      setGenerating(false);
    }
  }, [inputValue, generating, createAgent.mutateAsync, router, t, selectedArchetype, modelId]);

  if (generating) {
    return (
      <View className="flex-1 items-center justify-center">
        <Loading variant="spinner" size="lg" text={t("agents.generating")} />
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerClassName="grow items-center justify-center px-4 py-10"
      keyboardShouldPersistTaps="handled"
    >
      <View className="w-full max-w-[672px] gap-6">
        <Text className="text-center text-lg font-semibold leading-[26px] text-foreground">
          {t("agents.createTitle")}
        </Text>

        {/* Archetype picker: one radio row per archetype. */}
        <View className="gap-2">
          <Muted>{t("pages.agents.agentType")}</Muted>
          <View accessibilityRole="radiogroup" accessibilityLabel={t("pages.agents.agentType")}>
            {ARCHETYPE_OPTIONS.map((option) => (
              <Item
                key={option.value}
                role="radio"
                selected={selectedArchetype === option.value}
                onPress={() => setSelectedArchetype(option.value)}
                leading={<option.Icon width={20} height={20} />}
                trailing={
                  selectedArchetype === option.value ? <RiCheckLine size="md" /> : null
                }
                title={option.label}
                subtitle={option.description}
              />
            ))}
          </View>
        </View>

        {/*
          The simple composer: a field, a send control and the model picker,
          which here chooses the NEW AGENT's model. `busy` and `disabled` carry the
          same flag on purpose: there is no stream to cancel here, so
          generating greys send rather than offering a stop, and with no
          `onStop` Bloom draws no stop control at all.
        */}
        <Composer
          {...composer.props}
          value={inputValue}
          onValueChange={setInputValue}
          onSubmit={handleGenerate}
          busy={generating}
          disabled={generating}
          placeholder={t("agents.createPlaceholder")}
        />
      </View>
    </ScrollView>
  );
}
