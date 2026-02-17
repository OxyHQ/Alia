import React, { useState, useCallback } from "react";
import { View, ActivityIndicator } from "react-native";
import { Text } from "@/components/ui/text";
import { PromptInput } from "@/components/ui/prompt-input";
import { useRouter } from "expo-router";
import { useAgentsStore } from "@/lib/stores/agents-store";
import { useTranslation } from "@/hooks/useTranslation";
import { toast } from "@/components/sonner";
import apiClient from "@/lib/api/client";
import { API_ROUTES } from "@/lib/api/routes";

export default function CreateAgentScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const createAgent = useAgentsStore((state) => state.createAgent);

  const [inputValue, setInputValue] = useState("");
  const [generating, setGenerating] = useState(false);

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
  }, [inputValue, generating, createAgent, router, t]);

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
    <View className="flex-1 bg-background items-center justify-center px-5">
      <View className="w-full max-w-2xl gap-6">
        {/* Title */}
        <Text className="text-2xl font-semibold text-foreground text-center">
          {t("agents.createTitle")}
        </Text>

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
    </View>
  );
}
