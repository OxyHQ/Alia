import { AgentIdentityFields } from '@/components/agents/edit/agent-identity-fields';
import {
  AgentEditorSidebar,
  type SidebarTab,
} from '@/components/agents/edit/agent-editor-sidebar';
import { ArchetypeConfigSection } from '@/components/agents/edit/archetype-config';
import {
  useAgentDraftAutosave,
  useAgentIdentityAutosave,
} from '@/lib/hooks/agents/use-agent-autosave';
import { useAgentEditorActions } from '@/lib/hooks/agents/use-agent-editor-actions';
import {
  useAttachableSkills,
  useGrantableConnectors,
  useKnowledgeLibrary,
} from '@/lib/hooks/agents/use-agent-editor-options';
import { useAgentTelegramBots } from '@/lib/hooks/agents/use-agent-telegram-bots';
import { useIsLargeScreen } from '@/lib/hooks/use-is-large-screen';
import { useTranslation } from '@/lib/hooks/use-translation';
import type { Agent } from '@/lib/types/agents';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { ButtonGroup, ButtonGroupItem } from '@oxy.so/bloom/button-group';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Divider } from '@oxy.so/bloom/divider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@oxy.so/bloom/dropdown-menu';
import {
  RiDeleteBinLine,
  RiMore2Line,
  RiSettings3Line,
} from '@oxy.so/bloom/icons';
import { Textarea } from '@oxy.so/bloom/textarea';
import { Stack } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

const NO_SKILLS: never[] = [];
const NO_CONNECTORS: never[] = [];

/**
 * The agent editor, for one loaded agent. It owns the draft; the route owns
 * loading it — see `app/(app)/agents/edit/[id].tsx` for why the two are split
 * and why this is keyed on the agent.
 *
 * Everything the editor offers to attach (skills, connectors, library files,
 * Telegram bots) is asked for here, when the editor opens, and handed down —
 * the side column may be a sheet that is not mounted yet.
 */
export function AgentEditor({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const isLargeScreen = useIsLargeScreen();

  const { draft, editDraft } = useAgentDraftAutosave(agent);
  const { identity, editIdentity } = useAgentIdentityAutosave(agent);
  const { isPublished, togglePublished, deleteWithConfirm } =
    useAgentEditorActions(agent);

  const attachableSkills = useAttachableSkills().data ?? NO_SKILLS;
  const connectors = useGrantableConnectors(agent._id).data ?? NO_CONNECTORS;
  const libraryFiles = useKnowledgeLibrary();
  const telegram = useAgentTelegramBots(agent._id);

  const [showPanel, setShowPanel] = useState(isLargeScreen);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('resources');

  const sidebarContent = (
    <AgentEditorSidebar
      tab={sidebarTab}
      onTabChange={setSidebarTab}
      draft={draft}
      onEdit={editDraft}
      attachableSkills={attachableSkills}
      connectors={connectors}
      libraryFiles={libraryFiles}
      telegram={telegram}
    />
  );

  return (
    <View className="flex-1 flex-row">
      {/* Main column */}
      <View className="flex-1">
        <Stack.Screen
          options={{
            title: t('agents.instructions'),
            headerBackVisible: true,
            headerRight: () => (
              <>
                <ButtonGroup
                  accessibilityLabel={t('pages.agents.agentActions')}
                >
                  {!isLargeScreen && (
                    <ButtonGroupItem
                      iconOnly
                      leadingIcon={RiSettings3Line}
                      accessibilityLabel={t('agents.settings')}
                      onPress={() => setShowPanel(true)}
                    />
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger label="Actions" asChild>
                      <ButtonGroupItem
                        iconOnly
                        leadingIcon={RiMore2Line}
                        accessibilityLabel={t('pages.agents.moreActions')}
                      />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem
                        key="delete"
                        onPress={deleteWithConfirm}
                        leading={<RiDeleteBinLine size="sm" />}
                      >
                        {t('agents.deleteAgent')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </ButtonGroup>
                <Button size="md" tone="action" onPress={togglePublished}>
                  {isPublished ? t('agents.unpublish') : t('agents.publish')}
                </Button>
              </>
            ),
          }}
        />

        {/* Main editor */}
        <ScrollView
          className="flex-1"
          contentContainerClassName="gap-6 p-4 pb-[60px]"
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Where the agent stands: published or a draft, and its kind. */}
          <View className="flex-row flex-wrap items-center gap-2">
            <Badge
              size="label-small"
              variant="subtle"
              color={isPublished ? 'success' : 'default'}
              content={isPublished ? t('agents.published') : t('agents.draft')}
            />
            {draft.archetype !== 'general' && (
              <Badge
                size="label-small"
                variant="subtle"
                color="info"
                content={draft.archetype.replace('_', ' ')}
              />
            )}
          </View>

          <AgentIdentityFields identity={identity} onEdit={editIdentity} />

          {/* System prompt / instructions: the page-sized writing surface. */}
          <Textarea
            testID="agent-system-prompt"
            accessibilityLabel={t('agents.systemPromptPlaceholder')}
            value={draft.systemPrompt}
            onChangeText={(text) => editDraft({ systemPrompt: text })}
            placeholder={t('agents.systemPromptPlaceholder')}
            rows={14}
            autoResize
          />

          {/* Archetype-specific configuration */}
          <ArchetypeConfigSection
            archetype={draft.archetype}
            config={draft.archetypeConfig}
            onChange={(archetypeConfig) => editDraft({ archetypeConfig })}
          />
        </ScrollView>
      </View>

      {/* The side column — inline from the large breakpoint, a side sheet below it. */}
      {isLargeScreen ? (
        <>
          <Divider vertical />
          <View className="w-[320px]">{sidebarContent}</View>
        </>
      ) : (
        <Dialog
          open={showPanel}
          onClose={() => setShowPanel(false)}
          placement="right"
          width={320}
          title={t('agents.settings')}
          contentPadding={0}
          scrollable={false}
        >
          {sidebarContent}
        </Dialog>
      )}
    </View>
  );
}
