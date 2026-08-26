import React, { useState, useCallback } from "react";
import { View, ActivityIndicator, Pressable, ScrollView } from "react-native";
import { Text } from "@/components/ui/text";
import { PromptInput } from "@/components/ui/prompt-input/prompt-input";
import { useRouter } from "expo-router";
import { useCreateAgent } from "@/lib/hooks/use-agents";
import { useOxy } from "@oxyhq/services";
import { SELECTABLE_ACCOUNT_CATEGORY_IDS, type AccountCategoryId } from "@oxyhq/core";
import { applyBotUsernameSuffix, createBotAccount } from "@/lib/agents/bot-account";
import { useTranslation } from "@/lib/hooks/use-translation";
import { toast } from "@oxyhq/bloom/toast";
import apiClient from "@/lib/api/client";
import { API_ROUTES } from "@/lib/api/routes";
import { Sparkles, MessageCircleQuestion, GitBranch, BarChart3 } from "lucide-react-native";
import { errorMessage as getErrorMessage } from '@/lib/errors/error-utils';
import { ContentPanel } from "@oxyhq/bloom/content-panel";

type Archetype = 'general' | 'qa' | 'task_router' | 'status_update';

interface ArchetypeOption {
  value: Archetype;
  label: string;
  description: string;
  Icon: React.ComponentType<{ size: number; className?: string }>;
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
    Icon: Sparkles,
  },
  {
    value: 'qa',
    label: 'Q&A',
    description: 'Answers questions from your knowledge',
    Icon: MessageCircleQuestion,
  },
  {
    value: 'task_router',
    label: 'Task Router',
    description: 'Triages and routes incoming tasks',
    Icon: GitBranch,
  },
  {
    value: 'status_update',
    label: 'Status Update',
    description: 'Generates scheduled reports',
    Icon: BarChart3,
  },
];

export default function CreateAgentScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const createAgent = useCreateAgent();
  const { createAccount, oxyServices } = useOxy();

  const [inputValue, setInputValue] = useState("");
  const [generating, setGenerating] = useState(false);
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
  }, [inputValue, generating, createAgent.mutateAsync, router, t, selectedArchetype]);

  if (generating) {
    return (
      <View className="flex-1 bg-background items-center justify-center gap-4">
        <ActivityIndicator size="large" />
        <Text className="text-base text-muted-foreground">
          {t("agents.generating")}
        </Text>
      </View>
    );
  }

  return (
    <ContentPanel surfaceClassName="bg-background">
      <ScrollView
        className="flex-1 bg-background"
        contentContainerClassName="items-center justify-center px-5 py-10 min-h-full"
        keyboardShouldPersistTaps="handled"
      >
        <View className="w-full max-w-2xl gap-6">
          {/* Title */}
          <Text className="text-2xl font-semibold text-foreground text-center">
            {t("agents.createTitle")}
          </Text>

          {/* Archetype Picker */}
          <View className="gap-2">
            <Text className="text-sm font-medium text-muted-foreground">
              Agent type
            </Text>
            <View className="flex-row flex-wrap gap-3">
              {ARCHETYPE_OPTIONS.map((option) => {
                const isSelected = selectedArchetype === option.value;
                return (
                  <Pressable
                    key={option.value}
                    onPress={() => setSelectedArchetype(option.value)}
                    className={`flex-1 min-w-[45%] rounded-xl border p-4 gap-2 ${
                      isSelected
                        ? "bg-primary/10 border-primary"
                        : "bg-card border-border"
                    }`}
                  >
                    <option.Icon
                      size={20}
                      className={isSelected ? "text-primary" : "text-muted-foreground"}
                    />
                    <Text
                      className={`text-sm font-semibold ${
                        isSelected ? "text-primary" : "text-foreground"
                      }`}
                    >
                      {option.label}
                    </Text>
                    <Text className="text-xs text-muted-foreground leading-4">
                      {option.description}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <PromptInput
            value={inputValue}
            onValueChange={setInputValue}
            onSubmit={handleGenerate}
            isLoading={generating}
            disabled={generating}
            placeholder={t("agents.createPlaceholder")}
            autocomplete
            autocompletePosition="bottom"
          />
        </View>
      </ScrollView>
    </ContentPanel>

  );
}
