import { KnowledgePickerDialog } from '@/features/agents/ui/edit/knowledge-picker-dialog';
import { SkillPickerDialog } from '@/features/agents/ui/edit/skill-picker-dialog';
import { AgentCapabilityToggles } from '@/features/agents/ui/agent-capability-toggles';
import { AgentConnectorGrants } from '@/features/agents/ui/agent-connector-grants';
import type { GrantableConnector } from '@/features/chat/model/capability-families';
import type {
  AgentDraft,
  LinkedSkill,
} from '@/features/agents/runtime/use-agent-autosave';
import { useTranslation } from '@/shared/i18n/use-translation';
import type { LibraryFile } from '@/features/library/runtime/library-store';
import { Button } from '@oxy.so/bloom/button';
import { RiAddLine, RiCloseLine, RiFileTextLine } from '@oxy.so/bloom/icons';
import {
  SettingsListGroup,
  SettingsListItem,
} from '@oxy.so/bloom/settings-list';
import { Text } from '@oxy.so/bloom/typography';
import { useState } from 'react';

/**
 * What the agent can reach: its skills, capabilities, connectors and knowledge.
 *
 * Every change is an edit of the draft, so it autosaves like any field.
 */
export function AgentResourcesPanel({
  draft,
  onEdit,
  attachableSkills,
  connectors,
  libraryFiles,
}: {
  draft: Pick<AgentDraft, 'skills' | 'knowledge' | 'capabilityGrants'>;
  onEdit: (patch: Partial<AgentDraft>) => void;
  attachableSkills: readonly LinkedSkill[];
  /** The connectors this owner could grant. Empty until the fetch lands. */
  connectors: GrantableConnector[];
  libraryFiles: readonly LibraryFile[];
}) {
  const { t } = useTranslation();
  const [showSkillPicker, setShowSkillPicker] = useState(false);
  const [showKnowledgePicker, setShowKnowledgePicker] = useState(false);
  const { skills, knowledge, capabilityGrants } = draft;

  return (
    <>
      {/* Skills */}
      <SettingsListGroup title={t('agents.skills')}>
        {skills.map((skill) => (
          <SettingsListItem
            key={skill._id}
            icon={<Text>{skill.icon ?? '\u{1F9E9}'}</Text>}
            title={skill.displayName}
            rightElement={
              <Button
                size="xs"
                tone="neutral"
                appearance="plain"
                icon={RiCloseLine}
                accessibilityLabel={`${t('agents.removeSkill')}: ${skill.displayName}`}
                onPress={() =>
                  onEdit({
                    skills: skills.filter((s) => s._id !== skill._id),
                  })
                }
              />
            }
          />
        ))}
        <SettingsListItem
          icon={<RiAddLine size="md" />}
          title={t('agents.addSkill')}
          onPress={() => setShowSkillPicker(true)}
          showChevron={false}
        />
      </SettingsListGroup>
      <SkillPickerDialog
        open={showSkillPicker}
        onClose={() => setShowSkillPicker(false)}
        skills={attachableSkills}
        linked={skills}
        onPick={(skill) => onEdit({ skills: [...skills, skill] })}
      />

      {/* Capabilities — ONE list. It was two, "Tools" and "Permissions",
          which overlapped on four concepts and disagreed on all four. */}
      <AgentCapabilityToggles
        title={t('agents.capabilities')}
        footer={t('agents.capabilitiesFooter')}
        grants={capabilityGrants}
        onChange={(grants) => onEdit({ capabilityGrants: grants })}
      />

      {/* Connectors, granted one at a time — see the component. */}
      <AgentConnectorGrants
        connectors={connectors}
        grants={capabilityGrants}
        onChange={(grants) => onEdit({ capabilityGrants: grants })}
      />

      {/* Knowledge (Library Files) */}
      <SettingsListGroup title={t('agents.knowledge')}>
        {knowledge.map((file) => (
          <SettingsListItem
            key={file._id}
            icon={<RiFileTextLine size="md" />}
            title={file.name}
            rightElement={
              <Button
                size="xs"
                tone="neutral"
                appearance="plain"
                icon={RiCloseLine}
                accessibilityLabel={`${t('agents.removeKnowledge')}: ${file.name}`}
                onPress={() =>
                  onEdit({
                    knowledge: knowledge.filter((k) => k._id !== file._id),
                  })
                }
              />
            }
          />
        ))}
        <SettingsListItem
          icon={<RiAddLine size="md" />}
          title={t('agents.addKnowledge')}
          onPress={() => setShowKnowledgePicker(true)}
          showChevron={false}
        />
      </SettingsListGroup>
      <KnowledgePickerDialog
        open={showKnowledgePicker}
        onClose={() => setShowKnowledgePicker(false)}
        files={libraryFiles}
        linked={knowledge}
        onPick={(file) => onEdit({ knowledge: [...knowledge, file] })}
      />
    </>
  );
}
