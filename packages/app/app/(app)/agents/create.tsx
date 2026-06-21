import React, { useState, useCallback } from "react";
import { View, ActivityIndicator, Pressable, ScrollView } from "react-native";
import { Text } from "@/components/ui/text";
import { PromptInput } from "@/components/ui/prompt-input";
import { useRouter } from "expo-router";
import { useAgentsStore } from "@/lib/stores/agents-store";
import { useTranslation } from "@/hooks/useTranslation";
import { toast } from "@/components/sonner";
import apiClient from "@/lib/api/client";
import { API_ROUTES } from "@/lib/api/routes";
import { Sparkles, MessageCircleQuestion, GitBranch, BarChart3 } from "lucide-react-native";

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

  const [inputValue, setInputValue] = useState("");
  const [generating, setGenerating] = useState(false);
  const [selectedArchetype, setSelectedArchetype] = useState<Archetype>('general');

  const handleGenerate = useCallback(async () => {
    if (!inputValue.trim() || generating) return;
    setGenerating(true);

    try {
      // Step 1: AI generates agent config from prompt
      const genRes = await apiClient.post(API_ROUTES.agents.generate, {
        prompt: inputValue.trim(),
      });
      const config = genRes.data;

      // Step 2: Generate avatar (graceful degradation)
      let avatarUrl: string | null = null;
      try {
        const avatarRes = await apiClient.post(
          API_ROUTES.agents.generateAvatar,
          { name: config.name, description: config.description },
          { timeout: 60000 }
        );
        avatarUrl = avatarRes.data.avatarUrl;
      } catch {
        // Continue without avatar
      }

      // Step 3: Create the agent as draft
      const agent = await createAgent({
        ...config,
        avatar: avatarUrl,
        isPublished: false,
        archetype: config.archetype || selectedArchetype,
      });

      if (agent) {
        toast.success(t("agents.agentUpdated"));
        router.replace(`/(app)/agents/edit/${agent._id}` as any);
      } else {
        toast.error("Failed to create agent");
      }
    } catch (error: any) {
      const message =
        error?.response?.data?.error || "Failed to generate agent";
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
  );
}
