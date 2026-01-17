import React from "react";
import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { useRouter } from "expo-router";
import { Building2, Plus, ChevronDown } from "lucide-react-native";
import { useOrganizations } from "@/lib/hooks/use-organization";
import { useOrganizationStore } from "@/lib/stores/organization-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export const OrganizationSwitcher = React.memo(function OrganizationSwitcher() {
  const router = useRouter();
  const { data: organizations = [] } = useOrganizations();
  const { selectedOrgId, setSelectedOrg } = useOrganizationStore();

  const selectedOrg = organizations.find((org) => org._id === selectedOrgId);
  const displayName = selectedOrg ? selectedOrg.name : "Personal Account";

  const handleSelectOrg = (orgId: string | null) => {
    setSelectedOrg(orgId);
  };

  const handleCreateOrg = () => {
    router.push("/developers/organizations/new");
  };

  return (
    <View className="px-3 md:px-2 pb-3 md:pb-2 border-b border-border/50">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Pressable className="flex-row items-center justify-between p-2 rounded-md active:bg-muted">
            <View className="flex-row items-center gap-2 flex-1">
              <Building2 size={16} className="text-muted-foreground" />
              <Text className="text-sm md:text-xs font-medium text-foreground" numberOfLines={1}>
                {displayName}
              </Text>
            </View>
            <ChevronDown size={14} className="text-muted-foreground" />
          </Pressable>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="bottom"
          align="start"
          className="w-64"
        >
          {/* Personal Account */}
          <DropdownMenuItem
            onPress={() => handleSelectOrg(null)}
            className={selectedOrgId === null ? "bg-muted" : ""}
          >
            <Building2 size={16} className="text-muted-foreground" />
            <Text className="text-sm">Personal Account</Text>
          </DropdownMenuItem>

          {organizations.length > 0 && (
            <>
              <DropdownMenuSeparator />
              {organizations.map((org) => (
                <DropdownMenuItem
                  key={org._id}
                  onPress={() => handleSelectOrg(org._id)}
                  className={selectedOrgId === org._id ? "bg-muted" : ""}
                >
                  <Building2 size={16} className="text-muted-foreground" />
                  <View className="flex-1">
                    <Text className="text-sm">{org.name}</Text>
                    <Text className="text-xs text-muted-foreground">{org.role}</Text>
                  </View>
                </DropdownMenuItem>
              ))}
            </>
          )}

          <DropdownMenuSeparator />
          <DropdownMenuItem onPress={handleCreateOrg}>
            <Plus size={16} className="text-muted-foreground" />
            <Text className="text-sm">Create organization</Text>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
});
