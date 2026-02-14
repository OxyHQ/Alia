import React from "react";
import { View, Alert } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useOxy } from "@oxyhq/services";
import {
  useOrganizations,
  useOrganization,
  useUpdateOrganization,
  useDeleteOrganization,
  useOrganizationMembers,
} from "@/lib/hooks/use-organization";
import { useOrganizationStore } from "@/lib/stores/organization-store";
import { Users, Brain, Trash2, Save } from "lucide-react-native";
import { useRouter } from "expo-router";
import type { Organization, OrganizationMember } from "@/lib/hooks/use-organization";

export function WorkspaceSection() {
  const router = useRouter();
  const { user } = useOxy();
  const { data: organizations } = useOrganizations();
  const selectedOrgId = useOrganizationStore((s) => s.selectedOrgId);
  const setSelectedOrg = useOrganizationStore((s) => s.setSelectedOrg);
  const updateMutation = useUpdateOrganization();
  const deleteMutation = useDeleteOrganization();

  const isPersonal = !selectedOrgId;
  const currentOrg = organizations?.find((o) => o._id === selectedOrgId);

  const { data: members } = useOrganizationMembers(selectedOrgId || "");

  const [name, setName] = React.useState(currentOrg?.name || "");
  const [description, setDescription] = React.useState(currentOrg?.description || "");

  React.useEffect(() => {
    setName(currentOrg?.name || "");
    setDescription(currentOrg?.description || "");
  }, [currentOrg]);

  const isOwner = currentOrg?.role === "owner";
  const isAdmin = currentOrg?.role === "admin";
  const canEdit = isOwner || isAdmin;

  const handleSave = async () => {
    if (!selectedOrgId || !name.trim()) return;
    try {
      await updateMutation.mutateAsync({
        id: selectedOrgId,
        data: { name: name.trim(), description: description.trim() || undefined },
      });
      Alert.alert("Success", "Workspace updated");
    } catch {
      Alert.alert("Error", "Failed to update workspace");
    }
  };

  const handleDelete = () => {
    if (!selectedOrgId || !currentOrg) return;
    Alert.alert(
      "Delete workspace",
      `Are you sure you want to delete "${currentOrg.name}"? This action cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await deleteMutation.mutateAsync(selectedOrgId);
              setSelectedOrg(null);
              Alert.alert("Success", "Workspace deleted");
            } catch {
              Alert.alert("Error", "Failed to delete workspace");
            }
          },
        },
      ]
    );
  };

  if (isPersonal) {
    return (
      <View className="gap-6">
        <View className="flex-row items-center gap-4">
          <View className="w-12 h-12 rounded-lg bg-primary items-center justify-center">
            <Brain size={24} className="text-primary-foreground" />
          </View>
          <View className="flex-1">
            <Text className="text-lg font-semibold">Personal Account</Text>
            <Text className="text-sm text-muted-foreground">
              Your personal workspace
            </Text>
          </View>
        </View>
        <View className="p-4 rounded-lg border border-border">
          <Text className="text-sm text-muted-foreground">
            This is your personal workspace. Switch to a team workspace to manage settings.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View className="gap-6">
      {/* Workspace Header */}
      <View className="flex-row items-center gap-4">
        <View className="w-12 h-12 rounded-lg bg-primary items-center justify-center">
          <Users size={24} className="text-primary-foreground" />
        </View>
        <View className="flex-1">
          <Text className="text-lg font-semibold">{currentOrg?.name || "Workspace"}</Text>
          <Text className="text-sm text-muted-foreground">Team workspace</Text>
        </View>
      </View>

      {/* General Settings */}
      <View className="gap-4">
        <Text className="text-sm font-semibold">General</Text>
        <View className="gap-3">
          <View className="gap-1.5">
            <Text className="text-sm text-muted-foreground">Name</Text>
            <Input
              value={name}
              onChangeText={setName}
              editable={canEdit}
              maxLength={50}
              placeholder="Workspace name"
            />
          </View>
          <View className="gap-1.5">
            <Text className="text-sm text-muted-foreground">Description</Text>
            <Input
              value={description}
              onChangeText={setDescription}
              editable={canEdit}
              placeholder="A brief description"
              multiline
              numberOfLines={2}
            />
          </View>
          {canEdit && (
            <Button
              onPress={handleSave}
              disabled={updateMutation.isPending || !name.trim()}
              className="self-start"
            >
              <View className="flex-row items-center gap-2">
                <Save size={14} className="text-primary-foreground" />
                <Text className="text-sm font-medium text-primary-foreground">
                  {updateMutation.isPending ? "Saving..." : "Save changes"}
                </Text>
              </View>
            </Button>
          )}
        </View>
      </View>

      {/* Members */}
      <View className="gap-4">
        <Text className="text-sm font-semibold">
          Members {members ? `(${members.length})` : ""}
        </Text>
        {members?.map((member) => (
          <View
            key={member._id}
            className="flex-row items-center gap-3 p-3 rounded-lg border border-border"
          >
            <View className="w-8 h-8 rounded-full bg-muted items-center justify-center">
              <Text className="text-xs font-bold text-muted-foreground">
                {(member.userId?.name?.[0] || member.userId?.email?.[0] || "?").toUpperCase()}
              </Text>
            </View>
            <View className="flex-1">
              <Text className="text-sm font-medium">
                {member.userId?.name || member.userId?.email || "Unknown"}
              </Text>
              {member.userId?.email && (
                <Text className="text-xs text-muted-foreground">{member.userId.email}</Text>
              )}
            </View>
            <View className="px-2 py-0.5 rounded-full bg-muted">
              <Text className="text-xs text-muted-foreground capitalize">{member.role}</Text>
            </View>
          </View>
        ))}
        {!members?.length && (
          <View className="p-4 rounded-lg border border-border">
            <Text className="text-sm text-muted-foreground text-center">No members found</Text>
          </View>
        )}
      </View>

      {/* Danger Zone */}
      {isOwner && (
        <View className="gap-4">
          <Text className="text-sm font-semibold text-destructive">Danger Zone</Text>
          <View className="p-4 rounded-lg border border-destructive/30">
            <View className="flex-row items-center justify-between">
              <View className="flex-1 mr-4">
                <Text className="text-sm font-medium">Delete workspace</Text>
                <Text className="text-xs text-muted-foreground">
                  Permanently delete this workspace and all data.
                </Text>
              </View>
              <Button
                variant="destructive"
                onPress={handleDelete}
                disabled={deleteMutation.isPending}
              >
                <View className="flex-row items-center gap-1.5">
                  <Trash2 size={14} className="text-destructive-foreground" />
                  <Text className="text-sm font-medium text-destructive-foreground">Delete</Text>
                </View>
              </Button>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}
