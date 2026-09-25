import { AgentResourcesPanel } from '@/features/agents/ui/edit/agent-resources-panel';
import { AgentSettingsPanel } from '@/features/agents/ui/edit/agent-settings-panel';
import { ConnectTelegramBotDialog } from '@/features/agents/ui/edit/telegram-bots-section';
import type { GrantableConnector } from '@/features/chat/model/capability-families';
import type {
  AgentDraft,
  LinkedSkill,
} from '@/features/agents/runtime/use-agent-autosave';
import type { AgentTelegramBots } from '@/features/agents/runtime/use-agent-telegram-bots';
import { useTranslation } from '@/shared/i18n/use-translation';
import type { LibraryFile } from '@/features/library/runtime/library-store';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { ScrollView, View } from 'react-native';

export type SidebarTab = 'resources' | 'settings';

/**
 * The editor's side column: resources and settings, switched by Bloom's tab
 * strip. Inline from the large breakpoint, a side sheet below it — the editor
 * decides which; this is the same content either way.
 */
export function AgentEditorSidebar({
  tab,
  onTabChange,
  draft,
  onEdit,
  attachableSkills,
  connectors,
  libraryFiles,
  telegram,
}: {
  /**
   * Held by the editor rather than here, so the side sheet reopens on the tab
   * it was closed on.
   */
  tab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  draft: AgentDraft;
  onEdit: (patch: Partial<AgentDraft>) => void;
  attachableSkills: readonly LinkedSkill[];
  connectors: GrantableConnector[];
  libraryFiles: readonly LibraryFile[];
  telegram: AgentTelegramBots;
}) {
  const { t } = useTranslation();

  return (
    <View className="flex-1">
      <Tabs
        value={tab}
        onValueChange={(next) => onTabChange(next as SidebarTab)}
        fullWidth
      >
        <TabsTrigger value="resources" label={t('agents.resources')} />
        <TabsTrigger value="settings" label={t('agents.settings')} />
      </Tabs>

      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-4 p-4"
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {tab === 'resources' ? (
          <AgentResourcesPanel
            draft={draft}
            onEdit={onEdit}
            attachableSkills={attachableSkills}
            connectors={connectors}
            libraryFiles={libraryFiles}
          />
        ) : (
          <AgentSettingsPanel draft={draft} onEdit={onEdit} telegram={telegram} />
        )}
      </ScrollView>

      {/* Connect Telegram bot dialog */}
      <ConnectTelegramBotDialog telegram={telegram} />
    </View>
  );
}
