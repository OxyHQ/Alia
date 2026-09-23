import { useAgentTeams } from '@/lib/hooks/use-agent-teams';
import { useTranslation } from '@/lib/hooks/use-translation';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { RiTeamLine } from '@oxy.so/bloom/icons/RiTeamLine';
import { Loading } from '@oxy.so/bloom/loading';
import {
  SettingsListGroup,
  SettingsListItem,
} from '@oxy.so/bloom/settings-list';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useRouter } from 'expo-router';
import { ScrollView, View } from 'react-native';

/** Durable agent teams, each with one coordinator. Plain content on the layout's surface. */
export default function AgentTeamsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { data: teams = [], isLoading } = useAgentTeams();
  return (
    <ScrollView contentContainerClassName="gap-4 p-4">
      <View className="flex-row items-center gap-2">
        <Button
          size="sm"
          tone="neutral"
          appearance="plain"
          icon={RiArrowLeftLine}
          accessibilityLabel={t('pages.agents.back')}
          onPress={() => router.back()}
        />
        <View className="shrink">
          <Text variant="headline-semibold">{t('pages.agents.teamsTitle')}</Text>
          <Muted>{t('pages.agents.teamsDescription')}</Muted>
        </View>
      </View>
      {isLoading ? (
        <Loading variant="spinner" />
      ) : teams.length === 0 ? (
        <EmptyState
          icon={RiTeamLine}
          title={t('pages.agents.teamsEmpty')}
          description={t('pages.agents.teamsEmptyDetail')}
        />
      ) : (
        <SettingsListGroup>
          {teams.map((team) => (
            <SettingsListItem
              key={team.id}
              icon={<RiTeamLine size="md" />}
              title={team.name}
              description={team.instructions || t('pages.agents.noPlaybook')}
              showChevron={false}
            />
          ))}
        </SettingsListGroup>
      )}
    </ScrollView>
  );
}
