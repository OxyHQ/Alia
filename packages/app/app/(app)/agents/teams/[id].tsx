import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  View,
  ScrollView,
  Pressable,
  Alert,
  TextInput,
} from "react-native";
import { useIsLargeScreen } from "@/hooks/useIsLargeScreen";
import { Text } from "@/components/ui/text";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ArrowLeft,
  Plus,
  Users,
  X,
  Settings,
  Ellipsis,
  Zap,
  ChevronRight,
  Bot,
  FileText,
  Search,
  BookOpen,
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
import apiClient from "@/lib/api/client";
import { API_ROUTES } from "@/lib/api/routes";
import { useLibraryStore } from "@/lib/stores/library-store";

type LinkedSkill = { _id: string; skillId: string; title: string; icon: string; color: string };
type LinkedFile = { _id: string; name: string; type: string; category: string; url: string };

export default function TeamDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const isLargeScreen = useIsLargeScreen();

  const { data: team, isLoading } = useAgentTeam(id!);
  const removeAgent = useRemoveAgentFromTeam();
  const deleteTeam = useDeleteAgentTeam();
  const updateTeam = useUpdateAgentTeam();

  // Editable state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [showPanel, setShowPanel] = useState(isLargeScreen);
  const [saving, setSaving] = useState(false);

  // Linked skills & knowledge
  const [linkedSkills, setLinkedSkills] = useState<LinkedSkill[]>([]);
  const [linkedKnowledge, setLinkedKnowledge] = useState<LinkedFile[]>([]);
  const [allSkills, setAllSkills] = useState<LinkedSkill[]>([]);
  const [showSkillPicker, setShowSkillPicker] = useState(false);
  const [skillSearch, setSkillSearch] = useState("");
  const [showKnowledgePicker, setShowKnowledgePicker] = useState(false);
  const [knowledgeSearch, setKnowledgeSearch] = useState("");

  const libraryFiles = useLibraryStore((state) => state.files);
  const loadLibraryFiles = useLibraryStore((state) => state.loadFiles);

  // Auto-save
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const isInitialLoad = useRef(true);

  // Load available skills from backend
  useEffect(() => {
    apiClient.get(API_ROUTES.skills.list).then((res) => {
      setAllSkills(res.data.skills || []);
    }).catch((err) => console.error('Failed to load skills:', err));
    loadLibraryFiles();
  }, [loadLibraryFiles]);

  // Load team data into state
  useEffect(() => {
    if (team) {
      setName(team.name);
      setDescription(team.description || "");
      setLinkedSkills(team.skills || []);
      setLinkedKnowledge(team.knowledge || []);
      setTimeout(() => {
        isInitialLoad.current = false;
      }, 500);
    }
  }, [team]);

  // Debounced auto-save for name/description/skills/knowledge
  useEffect(() => {
    if (!id || isInitialLoad.current || !team) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      setSaving(true);
      try {
        await updateTeam.mutateAsync({
          id,
          data: {
            name,
            description,
            skills: linkedSkills.map((s) => s._id),
            knowledge: linkedKnowledge.map((k) => k._id),
          },
        });
      } catch {
        // silent
      } finally {
        setSaving(false);
      }
    }, 1000);
  }, [id, name, description, linkedSkills, linkedKnowledge, team, updateTeam]);

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

  const addLinkedSkill = useCallback((skill: LinkedSkill) => {
    setLinkedSkills((prev) => {
      if (prev.some((s) => s._id === skill._id)) return prev;
      return [...prev, skill];
    });
    setShowSkillPicker(false);
    setSkillSearch("");
  }, []);

  const removeLinkedSkill = useCallback((skillId: string) => {
    setLinkedSkills((prev) => prev.filter((s) => s._id !== skillId));
  }, []);

  const addLinkedKnowledge = useCallback((file: LinkedFile) => {
    setLinkedKnowledge((prev) => {
      if (prev.some((k) => k._id === file._id)) return prev;
      return [...prev, file];
    });
    setShowKnowledgePicker(false);
    setKnowledgeSearch("");
  }, []);

  const removeLinkedKnowledge = useCallback((fileId: string) => {
    setLinkedKnowledge((prev) => prev.filter((k) => k._id !== fileId));
  }, []);

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
        scrollEnabled={!isLargeScreen}
        contentContainerStyle={isLargeScreen ? { flex: 1 } : undefined}
      >
        <View className={isLargeScreen ? "flex-1" : ""}>
          {/* Linked Skills */}
          <View className={cn(isLargeScreen && "flex-1", "border-b border-border")}>
            <View className="px-4 pt-4 pb-2 flex-row items-center justify-between">
              <View className="flex-row items-center gap-2">
                <Zap size={16} className="text-foreground" />
                <Text className="text-sm font-semibold text-foreground">
                  {t("agents.skills")}
                </Text>
              </View>
              <Pressable
                onPress={() => setShowSkillPicker(!showSkillPicker)}
                className="active:opacity-70"
              >
                <Plus size={16} className="text-muted-foreground" />
              </Pressable>
            </View>
            <ScrollView
              className={cn(isLargeScreen && "flex-1")}
              showsVerticalScrollIndicator={false}
              scrollEnabled={isLargeScreen}
            >
              <View className="px-4 pb-4 gap-2">
                {linkedSkills.map((skill) => (
                  <View
                    key={skill._id}
                    className="flex-row items-center justify-between py-1.5"
                  >
                    <View className="flex-row items-center gap-2 flex-1">
                      <Text style={{ fontSize: 16 }}>{skill.icon}</Text>
                      <Text className="text-sm text-foreground flex-1" numberOfLines={1}>
                        {skill.title}
                      </Text>
                    </View>
                    <Pressable
                      onPress={() => removeLinkedSkill(skill._id)}
                      className="active:opacity-70 ml-2"
                    >
                      <X size={14} className="text-muted-foreground" />
                    </Pressable>
                  </View>
                ))}
              </View>
            </ScrollView>
            <Dialog open={showSkillPicker} onOpenChange={setShowSkillPicker}>
              <DialogContent overlayClassName={cn(!isLargeScreen && "px-0")} className={cn("p-0 gap-0", !isLargeScreen && "flex-1 max-w-none rounded-none border-0")}>
                <DialogHeader className="px-4 pt-4 pb-2">
                  <DialogTitle>{t("agents.skills")}</DialogTitle>
                </DialogHeader>
                <View className="mx-4 mb-2 flex-row items-center gap-2 px-3 py-1.5 border border-border rounded-md">
                  <Search size={14} className="text-muted-foreground" />
                  <TextInput
                    value={skillSearch}
                    onChangeText={setSkillSearch}
                    placeholder="Search skills..."
                    placeholderTextColor={colors.mutedForeground}
                    className="flex-1 text-sm text-foreground"
                    autoFocus
                  />
                </View>
                <ScrollView style={{ maxHeight: isLargeScreen ? 300 : undefined }} className={cn(!isLargeScreen && "flex-1")}>
                  {allSkills
                    .filter((s) =>
                      !linkedSkills.some((ls) => ls._id === s._id) &&
                      (!skillSearch || s.title.toLowerCase().includes(skillSearch.toLowerCase()))
                    )
                    .map((skill) => (
                      <Pressable
                        key={skill._id}
                        onPress={() => addLinkedSkill(skill)}
                        className="flex-row items-center gap-2 px-4 py-2 active:bg-muted"
                      >
                        <Text style={{ fontSize: 16 }}>{skill.icon}</Text>
                        <Text className="text-sm text-foreground">{skill.title}</Text>
                      </Pressable>
                    ))}
                </ScrollView>
              </DialogContent>
            </Dialog>
          </View>

          {/* Knowledge (Library Files) */}
          <View className={cn(isLargeScreen && "flex-1", "border-b border-border")}>
            <View className="px-4 pt-4 pb-2 flex-row items-center justify-between">
              <View className="flex-row items-center gap-2">
                <BookOpen size={16} className="text-foreground" />
                <Text className="text-sm font-semibold text-foreground">
                  {t("agents.knowledge")}
                </Text>
              </View>
              <Pressable
                onPress={() => setShowKnowledgePicker(!showKnowledgePicker)}
                className="active:opacity-70"
              >
                <Plus size={16} className="text-muted-foreground" />
              </Pressable>
            </View>
            <ScrollView
              className={cn(isLargeScreen && "flex-1")}
              showsVerticalScrollIndicator={false}
              scrollEnabled={isLargeScreen}
            >
              <View className="px-4 pb-4 gap-2">
                {linkedKnowledge.map((file) => (
                  <View
                    key={file._id}
                    className="flex-row items-center justify-between py-1.5"
                  >
                    <View className="flex-row items-center gap-2 flex-1">
                      <FileText size={14} className="text-muted-foreground" />
                      <Text className="text-sm text-foreground flex-1" numberOfLines={1}>
                        {file.name}
                      </Text>
                    </View>
                    <Pressable
                      onPress={() => removeLinkedKnowledge(file._id)}
                      className="active:opacity-70 ml-2"
                    >
                      <X size={14} className="text-muted-foreground" />
                    </Pressable>
                  </View>
                ))}
              </View>
            </ScrollView>
            <Dialog open={showKnowledgePicker} onOpenChange={setShowKnowledgePicker}>
              <DialogContent overlayClassName={cn(!isLargeScreen && "px-0")} className={cn("p-0 gap-0", !isLargeScreen && "flex-1 max-w-none rounded-none border-0")}>
                <DialogHeader className="px-4 pt-4 pb-2">
                  <DialogTitle>{t("agents.knowledge")}</DialogTitle>
                </DialogHeader>
                <View className="mx-4 mb-2 flex-row items-center gap-2 px-3 py-1.5 border border-border rounded-md">
                  <Search size={14} className="text-muted-foreground" />
                  <TextInput
                    value={knowledgeSearch}
                    onChangeText={setKnowledgeSearch}
                    placeholder="Search library..."
                    placeholderTextColor={colors.mutedForeground}
                    className="flex-1 text-sm text-foreground"
                    autoFocus
                  />
                </View>
                <ScrollView style={{ maxHeight: isLargeScreen ? 300 : undefined }} className={cn(!isLargeScreen && "flex-1")}>
                  {libraryFiles
                    .filter((f) =>
                      !linkedKnowledge.some((lk) => lk._id === f._id) &&
                      (!knowledgeSearch || f.name.toLowerCase().includes(knowledgeSearch.toLowerCase()))
                    )
                    .map((file) => (
                      <Pressable
                        key={file._id}
                        onPress={() => addLinkedKnowledge({
                          _id: file._id,
                          name: file.name,
                          type: file.type,
                          category: file.category,
                          url: file.url,
                        })}
                        className="flex-row items-center gap-2 px-4 py-2 active:bg-muted"
                      >
                        <FileText size={14} className="text-muted-foreground" />
                        <Text className="text-sm text-foreground flex-1" numberOfLines={1}>
                          {file.name}
                        </Text>
                      </Pressable>
                    ))}
                  {libraryFiles.length === 0 && (
                    <Text className="text-xs text-muted-foreground px-4 py-3 text-center">
                      No files in library. Upload files on the Library screen.
                    </Text>
                  )}
                </ScrollView>
              </DialogContent>
            </Dialog>
          </View>

          {/* Agents section */}
          <View className={cn(isLargeScreen && "flex-1")}>
            <View className="px-4 pt-4 pb-2 flex-row items-center justify-between">
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
            <ScrollView
              className={cn(isLargeScreen && "flex-1")}
              showsVerticalScrollIndicator={false}
              scrollEnabled={isLargeScreen}
            >
              <View className="px-4 pb-4 gap-2">
                {agents.length === 0 ? (
                  <Text className="text-xs text-muted-foreground">
                    {t("agents.noAgentsInTeam")}
                  </Text>
                ) : (
                  agents.map((agent: any) => (
                    <View
                      key={agent._id}
                      className="flex-row items-center justify-between py-1.5"
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
            </ScrollView>
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
            className="text-foreground"
            style={{
              fontSize: 24,
              fontWeight: "700",
              padding: 0,
              marginBottom: 12,
            }}
          />

          {/* Editable Description */}
          <Textarea
            variant="ghost"
            value={description}
            onChangeText={setDescription}
            placeholder="Describe this team's purpose..."
            placeholderTextColor={colors.mutedForeground}
            style={{ fontSize: 15, lineHeight: 22, minHeight: 100, marginBottom: 24 }}
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
