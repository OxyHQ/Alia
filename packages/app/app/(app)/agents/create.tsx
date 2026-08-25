import React, { useState, useCallback } from "react";
import { View, ActivityIndicator, Pressable, ScrollView } from "react-native";
import { Text } from "@/components/ui/text";
import { PromptInput } from "@/components/ui/prompt-input/prompt-input";
import { useRouter } from "expo-router";
import { useAgentsStore } from "@/lib/stores/agents-store";
import { useOxy } from "@oxyhq/services";
import { createBotAccount } from "@/lib/agents/bot-account";
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
  const createAgent = useAgentsStore((state) => state.createAgent);
  const { createAccount } = useOxy();

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
       * There is no avatar step. An agent's likeness is
       * `components/ui/agent-glyph.tsx` drawn in the account's own `User.color`
       * — a field `createAccount` cannot carry, so a new agent starts out drawn
       * in the theme's color and stays that way until Oxy can set one.
       */
      const account = await createBotAccount({
        createAccount,
        username: config.suggestedUsername,
        displayName: config.name,
        bio: config.tagline,
        // This screen builds a DRAFT (`isPublished: false` below), so the
        // account is minted undiscoverable to match: kept out of Oxy's global
        // people search from the moment it exists, rather than listed there
        // under its owner's name until they publish it.
        private: true,
      });

      // Step 3: create the RUNTIME, bound to that account.
      const agent = await createAgent({
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

      if (agent) {
        toast.success(t("agents.agentUpdated"));
        router.replace({ pathname: "/(app)/agents/edit/[id]", params: { id: agent._id } });
      } else {
        toast.error("Failed to create agent");
      }
    } catch (error: unknown) {
      const message =
        getErrorMessage(error, "Failed to generate agent");
      toast.error(message);
    } finally {
      setGenerating(false);
    }
  }, [inputValue, generating, createAgent, router, t, selectedArchetype]);

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
