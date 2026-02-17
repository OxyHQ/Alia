import React, { useState, useCallback } from "react";
import { View, ActivityIndicator } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputActions,
  PromptInputMicButton,
} from "@/components/ui/prompt-input";
import { ArrowUp, Plus } from "lucide-react-native";
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

        {/* Prompt Input */}
        <PromptInput
          value={inputValue}
          onValueChange={setInputValue}
          onSubmit={handleCreate}
          isLoading={creating}
          disabled={creating}
        >
          <PromptInputTextarea
            value={inputValue}
            onChangeText={setInputValue}
            placeholder={t("agents.createTeamPlaceholder")}
            className="min-h-[44px] text-base py-3"
          />
          <PromptInputActions className="flex-row items-center justify-between gap-2 mt-2 mb-1 px-3">
            <View className="flex-row items-center gap-1.5">
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 rounded-full border-0"
                onPress={() => {
                  /* future */
                }}
              >
                <Plus size={16} className="text-muted-foreground" />
              </Button>
            </View>
            <View className="flex-row items-center gap-1.5">
              <PromptInputMicButton />
              <Button
                size="icon"
                onPress={handleCreate}
                disabled={!inputValue.trim()}
                className="h-8 w-8 rounded-full"
              >
                <ArrowUp size={16} color="white" />
              </Button>
            </View>
          </PromptInputActions>
        </PromptInput>
      </View>
    </View>
  );
}
