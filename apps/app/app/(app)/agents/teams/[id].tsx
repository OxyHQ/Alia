import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  View,
  ScrollView,
  Pressable,
  Alert,
  TextInput,
  useWindowDimensions,
} from "react-native";
import { Text } from "@/components/ui/text";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import {
  ArrowLeft,
  Plus,
  Trash2,
  Users,
  X,
  Settings,
  Ellipsis,
  Zap,
  ChevronRight,
  Bot,
} from "lucide-react-native";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useTranslation } from "@/hooks/useTranslation";
import { useColorScheme } from "@/lib/useColorScheme";
import {
  useAgentTeam,
  useRemoveAgentFromTeam,
  useDeleteAgentTeam,
  useUpdateAgentTeam,
} from "@/lib/hooks/use-agent-teams";
import { AgentCard } from "@/components/agent-card";
import { toast } from "@/components/sonner";
import { cn } from "@/lib/utils";

export default function TeamDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const { width } = useWindowDimensions();
  const isLargeScreen = width >= 768;

  const { data: team, isLoading } = useAgentTeam(id!);
  const removeAgent = useRemoveAgentFromTeam();
  const deleteTeam = useDeleteAgentTeam();
  const updateTeam = useUpdateAgentTeam();

  // Editable state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [showPanel, setShowPanel] = useState(isLargeScreen);
  const [saving, setSaving] = useState(false);

  // Auto-save
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const isInitialLoad = useRef(true);

  // Load team data into state
  useEffect(() => {
    if (team) {
      setName(team.name);
      setDescription(team.description || "");
      setTimeout(() => {
        isInitialLoad.current = false;
      }, 500);
    }
  }, [team]);

  // Debounced auto-save for name/description
  useEffect(() => {
    if (!id || isInitialLoad.current || !team) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      if (name === team.name && description === (team.description || "")) return;
      setSaving(true);
      try {
        await updateTeam.mutateAsync({ id, data: { name, description } });
      } catch {
        // silent
      } finally {
        setSaving(false);
      }
    }, 1000);
  }, [id, name, description, team, updateTeam]);

  const handleAgentPress = useCallback(
    (agentId: string) => {
      router.push(`/(app)/agents/${agentId}` as any);
    },
    [router]
  );

  const handleRemoveAgent = useCallback(
    (agentId: string) => {
      Alert.alert(
        t("agents.removeAgent"),
        t("agents.removeAgentConfirm") || "Remove this agent from the team?",
        [
          { text: t("common.cancel"), style: "cancel" },
          {
            text: t("agents.removeAgent"),
            style: "destructive",
            onPress: async () => {
              try {
                await removeAgent.mutateAsync({ teamId: id!, agentId });
                toast.success(t("agents.agentRemoved"));
              } catch {
                toast.error("Failed to remove agent");
              }
            },
          },
        ]
      );
    },
    [id, removeAgent, t]
  );

  const handleDeleteTeam = useCallback(() => {
    Alert.alert(t("agents.deleteTeam"), t("agents.deleteTeamConfirm"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("agents.deleteTeam"),
        style: "destructive",
        onPress: async () => {
          try {
            await deleteTeam.mutateAsync(id!);
            toast.success(t("agents.teamDeleted"));
            router.back();
          } catch {
            toast.error("Failed to delete team");
          }
        },
      },
    ]);
  }, [id, deleteTeam, router, t]);

  const handleAddAgent = useCallback(() => {
    router.push("/(app)/agents" as any);
  }, [router]);

  if (isLoading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <Text className="text-muted-foreground">{t("common.loading")}</Text>
      </View>
    );
  }

  if (!team) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <Text className="text-muted-foreground">Team not found</Text>
      </View>
    );
  }

  const agents = team.agents || [];

  // Right panel content
  const panelContent = (
    <View className="flex-1 bg-background">
      {/* Panel Header */}
      <View className="flex-row items-center justify-between px-4 py-3 border-b border-border">
        <Text className="text-base font-semibold text-foreground">
          {t("agents.resources")}
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

      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View className="p-4 gap-5">
          {/* Skills section (placeholder for team-level skills) */}
          <View className="gap-2">
            <View className="flex-row items-center gap-2">
              <Zap size={16} className="text-foreground" />
              <Text className="text-sm font-semibold text-foreground">
                {t("agents.skills")}
              </Text>
            </View>
            <Text className="text-xs text-muted-foreground pl-6">
              Skills are inherited from the agents in this team
            </Text>
          </View>

          {/* Agents section */}
          <View className="gap-2">
            <View className="flex-row items-center justify-between">
              <View className="flex-row items-center gap-2">
                <Bot size={16} className="text-foreground" />
                <Text className="text-sm font-semibold text-foreground">
                  {t("agents.agents")}
                </Text>
              </View>
              <Pressable onPress={handleAddAgent} className="active:opacity-70">
                <Plus size={16} className="text-foreground" />
              </Pressable>
            </View>
            {agents.length === 0 ? (
              <Text className="text-xs text-muted-foreground pl-6">
                {t("agents.noAgentsInTeam")}
              </Text>
            ) : (
              agents.map((agent: any) => (
                <View
                  key={agent._id}
                  className="flex-row items-center justify-between py-2 px-3 rounded-lg border border-border"
                >
                  <Pressable
                    onPress={() => handleAgentPress(agent._id)}
                    className="flex-1 flex-row items-center gap-2 active:opacity-70"
                  >
                    <Text
                      className="text-sm text-foreground flex-1"
                      numberOfLines={1}
                    >
                      {agent.name}
                    </Text>
                    <ChevronRight
                      size={14}
                      className="text-muted-foreground"
                    />
                  </Pressable>
                  <Pressable
                    onPress={() => handleRemoveAgent(agent._id)}
                    className="active:opacity-70 ml-2"
                  >
                    <X size={14} className="text-muted-foreground" />
                  </Pressable>
                </View>
              ))
            )}
          </View>
        </View>
      </ScrollView>
    </View>
  );

  return (
    <View className="flex-1 bg-background flex-row">
      {/* Main Content */}
      <View className="flex-1">
        {/* Header */}
        <View className="flex-row items-center justify-between px-4 py-3 border-b border-border">
          <View className="flex-row items-center gap-3 flex-1">
            <Pressable
              onPress={() => router.back()}
              className="active:opacity-70"
            >
              <ArrowLeft size={20} className="text-foreground" />
            </Pressable>
            <Text className="text-sm font-medium text-foreground">
              {t("agents.teams")}
            </Text>
            <ChevronRight size={14} className="text-muted-foreground" />
            <Text
              className="text-sm font-medium text-foreground flex-1"
              numberOfLines={1}
            >
              {team.name}
            </Text>
            {saving && (
              <Text className="text-xs text-muted-foreground">
                {t("agents.saving")}
              </Text>
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
                <DropdownMenu.Item key="delete" onSelect={handleDeleteTeam}>
                  <DropdownMenu.ItemIcon ios={{ name: "trash" }} />
                  <DropdownMenu.ItemTitle>
                    {t("agents.deleteTeam")}
                  </DropdownMenu.ItemTitle>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          </View>
        </View>

        {/* Main Editor */}
        <ScrollView
          className="flex-1"
          contentContainerStyle={{ padding: 20, paddingBottom: 60 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Editable Name */}
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Team name"
            placeholderTextColor={colors.mutedForeground}
            style={{
              fontSize: 24,
              fontWeight: "700",
              color: colors.foreground,
              padding: 0,
              marginBottom: 12,
            }}
          />

          {/* Editable Description */}
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="Describe this team's purpose..."
            placeholderTextColor={colors.mutedForeground}
            multiline
            style={{
              fontSize: 15,
              lineHeight: 22,
              color: colors.foreground,
              minHeight: 100,
              textAlignVertical: "top",
              padding: 0,
              marginBottom: 24,
            }}
          />

          {/* Agents Grid */}
          {agents.length === 0 ? (
            <View className="items-center justify-center py-12">
              <Users size={40} className="text-muted-foreground mb-3" />
              <Text className="text-muted-foreground text-center mb-4">
                {t("agents.noAgentsInTeam")}
              </Text>
              <Pressable
                onPress={handleAddAgent}
                className="flex-row items-center gap-1.5 px-4 py-2 rounded-full border border-border active:opacity-70"
              >
                <Plus size={14} className="text-foreground" />
                <Text className="text-[13px] font-medium text-foreground">
                  {t("agents.addAgent")}
                </Text>
              </Pressable>
            </View>
          ) : (
            <View className="flex-row flex-wrap" style={{ margin: -6 }}>
              {agents.map((agent: any) => (
                <View
                  key={agent._id}
                  style={{
                    width: isLargeScreen ? "33.33%" : "50%",
                    padding: 6,
                  }}
                >
                  <Pressable
                    onLongPress={() => handleRemoveAgent(agent._id)}
                  >
                    <AgentCard
                      agent={agent}
                      variant="grid"
                      onPress={handleAgentPress}
                    />
                  </Pressable>
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      </View>

      {/* Right Sidebar */}
      {isLargeScreen ? (
        <View
          style={{ width: 320 }}
          className="border-l border-border bg-background"
        >
          {panelContent}
        </View>
      ) : (
        <Panel
          open={showPanel}
          onClose={() => setShowPanel(false)}
          side="right"
          width={320}
        >
          {panelContent}
        </Panel>
      )}
    </View>
  );
}
