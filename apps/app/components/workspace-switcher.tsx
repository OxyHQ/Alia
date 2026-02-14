import React from "react";
import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ChevronDown,
  Check,
  Plus,
  Users,
  Brain,
  Settings2,
} from "lucide-react-native";
import { useRouter } from "expo-router";
import { useOxy } from "@oxyhq/services";
import { useOrganizations, useCreateOrganization } from "@/lib/hooks/use-organization";
import { useOrganizationStore } from "@/lib/stores/organization-store";
import type { Organization } from "@/lib/hooks/use-organization";

interface WorkspaceItem {
  id: string;
  name: string;
  type: "personal" | "team";
}

export const WorkspaceSwitcher = React.memo(function WorkspaceSwitcher() {
  const router = useRouter();
  const { user } = useOxy();
  const { data: organizations } = useOrganizations();
  const selectedOrgId = useOrganizationStore((s) => s.selectedOrgId);
  const setSelectedOrg = useOrganizationStore((s) => s.setSelectedOrg);

  const workspaces = React.useMemo((): WorkspaceItem[] => {
    const personal: WorkspaceItem = {
      id: "personal",
      name: "Personal Account",
      type: "personal",
    };
    const teams: WorkspaceItem[] = (organizations || []).map((org) => ({
      id: org._id,
      name: org.name,
      type: "team",
    }));
    return [personal, ...teams];
  }, [organizations]);

  const currentWorkspace = React.useMemo(() => {
    return workspaces.find((w) => w.id === selectedOrgId) || workspaces[0];
  }, [workspaces, selectedOrgId]);

  const handleSelect = React.useCallback(
    (workspace: WorkspaceItem) => {
      setSelectedOrg(workspace.id === "personal" ? null : workspace.id);
    },
    [setSelectedOrg]
  );

  const handleSettings = React.useCallback(() => {
    router.push("/(app)/settings/workspace" as any);
  }, [router]);

  if (!user) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Pressable className="flex-row items-center gap-2 px-3 md:px-2 py-2 rounded-lg active:bg-muted/50">
          <View className="h-7 w-7 rounded-md bg-primary items-center justify-center">
            {currentWorkspace?.type === "personal" ? (
              <Brain size={14} className="text-primary-foreground" />
            ) : (
              <Users size={14} className="text-primary-foreground" />
            )}
          </View>
          <Text className="text-sm md:text-xs font-medium flex-1" numberOfLines={1}>
            {currentWorkspace?.name || "Personal Account"}
          </Text>
          <ChevronDown size={14} className="text-muted-foreground" />
        </Pressable>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="start" className="w-64">
        <View className="px-2 py-1.5">
          <Text className="text-xs font-medium text-muted-foreground">Workspaces</Text>
        </View>
        {workspaces.map((workspace) => (
          <DropdownMenuItem
            key={workspace.id}
            onPress={() => handleSelect(workspace)}
          >
            <View className="h-6 w-6 rounded-md border border-border bg-primary items-center justify-center">
              {workspace.type === "personal" ? (
                <Brain size={12} className="text-primary-foreground" />
              ) : (
                <Users size={12} className="text-primary-foreground" />
              )}
            </View>
            <Text className="text-sm flex-1" numberOfLines={1}>
              {workspace.name}
            </Text>
            {currentWorkspace?.id === workspace.id && (
              <Check size={14} className="text-primary" />
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onPress={handleSettings}>
          <Settings2 size={14} className="text-muted-foreground" />
          <Text className="text-sm">Workspace settings</Text>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
