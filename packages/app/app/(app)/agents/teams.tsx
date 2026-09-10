import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ArrowLeft, Users } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { useAgentTeams } from '@/lib/hooks/use-agent-teams';

export default function AgentTeamsScreen() {
  const router = useRouter();
  const { data: teams = [], isLoading } = useAgentTeams();
  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center gap-3 border-b border-border px-4 py-3">
        <Pressable accessibilityLabel="Back" onPress={() => router.back()} className="p-2">
          <ArrowLeft size={20} className="text-foreground" />
        </Pressable>
        <View>
          <Text className="text-lg font-semibold">Agent teams</Text>
          <Text className="text-xs text-muted-foreground">Durable groups with one coordinator</Text>
        </View>
      </View>
      {isLoading ? <ActivityIndicator className="mt-10" /> : (
        <ScrollView contentContainerClassName="p-4 gap-3">
          {teams.map((team) => (
            <View key={team.id} className="rounded-2xl border border-border bg-surface p-4">
              <View className="flex-row items-center gap-3">
                <View className="rounded-xl bg-primary/10 p-2"><Users size={20} className="text-primary" /></View>
                <View className="flex-1">
                  <Text className="font-semibold">{team.name}</Text>
                  <Text className="text-xs text-muted-foreground" numberOfLines={2}>{team.instructions || 'No playbook yet'}</Text>
                </View>
              </View>
            </View>
          ))}
          {!teams.length && <Text className="py-12 text-center text-muted-foreground">No teams yet. Import an alia.team package through the API.</Text>}
        </ScrollView>
      )}
    </View>
  );
}
