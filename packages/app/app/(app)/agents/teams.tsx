import { useAgentTeams } from '@/lib/hooks/use-agent-teams';
import { useTranslation } from '@/lib/hooks/use-translation';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiTeamLine } from '@oxy.so/bloom/icons/RiTeamLine';
import { Loading } from '@oxy.so/bloom/loading';
import {
  SettingsListGroup,
  SettingsListItem,
} from '@oxy.so/bloom/settings-list';
import { Muted } from '@oxy.so/bloom/typography';
import { Stack } from 'expo-router';
import { ScrollView } from 'react-native';

/** Durable agent teams, each with one coordinator. Plain content on the layout's surface. */
export default function AgentTeamsScreen() {
  const { t } = useTranslation();
  const { data: teams = [], isLoading } = useAgentTeams();
  return (
    <>
      <Stack.Screen
        options={{
          title: t('pages.agents.teamsTitle'),
          headerBackVisible: true,
        }}
      />
      <ScrollView contentContainerClassName="gap-4 p-4">
        <Muted>{t('pages.agents.teamsDescription')}</Muted>
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
    </>
  );
}
