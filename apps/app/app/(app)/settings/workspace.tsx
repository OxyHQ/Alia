import { View, ScrollView } from "react-native";
import { WorkspaceSection } from "@/components/settings/workspace-section";
import { SettingsHeader } from "@/components/settings/settings-header";

export default function SettingsWorkspaceScreen() {
  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title="Workspace" />
      <ScrollView className="flex-1" contentContainerClassName="p-5 max-w-2xl">
        <WorkspaceSection />
      </ScrollView>
    </View>
  );
}
