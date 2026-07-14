import React, { useState, useCallback } from "react";
import { View, ActivityIndicator } from "react-native";
import { Text } from "@/components/ui/text";
import { PromptInput } from "@/components/ui/prompt-input/prompt-input";
import { useRouter } from "expo-router";
import { useCreateAgentTeam } from "@/lib/hooks/use-agent-teams";
import { useTranslation } from "@/hooks/useTranslation";
import { toast } from "@/components/sonner";

export default function CreateTeamScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const createTeam = useCreateAgentTeam();

  const [inputValue, setInputValue] = useState("");
  const [creating, setCreating] = useState(false);

  const handleCreate = useCallback(async () => {
    if (!inputValue.trim() || creating) return;
    setCreating(true);

    try {
      const text = inputValue.trim();

      // Extract a name from the first line or first few words
      const firstLine = text.split("\n")[0];
      const name =
        firstLine.length <= 60
          ? firstLine
          : firstLine.split(/\s+/).slice(0, 6).join(" ");

      const team = await createTeam.mutateAsync({
        name,
        description: text,
      });

      if (team) {
        toast.success(t("agents.teamCreated"));
        router.replace(`/(app)/agents/teams/${team._id}` as any);
      }
    } catch {
      toast.error("Failed to create team");
    } finally {
      setCreating(false);
    }
  }, [inputValue, creating, createTeam, router, t]);

  if (creating) {
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
          {t("agents.createTeamTitle")}
        </Text>

        <PromptInput
          value={inputValue}
          onValueChange={setInputValue}
          onSubmit={handleCreate}
          isLoading={creating}
          disabled={creating}
          placeholder={t("agents.createTeamPlaceholder")}
          autocomplete
          autocompletePosition="bottom"
        />
      </View>
    </View>
  );
}
