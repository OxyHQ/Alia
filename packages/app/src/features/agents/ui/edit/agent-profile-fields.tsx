import type { AgentDraft, IdentityDraft } from '@/features/agents/runtime/use-agent-autosave';
import { useTranslation } from '@/shared/i18n/use-translation';
import { AgentCreator, AgentCreatorField } from '@oxy.so/bloom/agent-creator';
import { TextFieldInput } from '@oxy.so/bloom/text-field';

/**
 * Who the agent is: Bloom's `AgentCreator` for the name, the tagline, the description and the
 * look, and the handle as a row of the editor's own card ().
 *
 * Two stores, one editor. The name (and the handle) are the bot ACCOUNT's, saved to Oxy; the
 * tagline, description and character are the agent row's, saved to Alia. The editor hands back one
 * agent, and each field is routed to the draft it belongs to. No voice: Alia's agents have none.
 */
export function AgentProfileFields({
  id,
  identity,
  draft,
  onEditIdentity,
  onEditDraft,
  onClose,
}: {
  id: string;
  identity: IdentityDraft;
  draft: Pick<AgentDraft, 'tagline' | 'description' | 'character'>;
  onEditIdentity: (patch: Partial<IdentityDraft>) => void;
  onEditDraft: (patch: Partial<AgentDraft>) => void;
  /** The creator's own close button, when the editor is a panel. */
  onClose?: () => void;
}) {
  const { t } = useTranslation();

  return (
    <AgentCreator
      style={{ flex: 1 }}
      onClose={onClose}
      showPreferences={false}
      agent={{
        id,
        name: identity.name,
        label: draft.tagline,
        description: draft.description,
        avatar: draft.character,
      }}
      onChange={(next) => {
        if (next.name !== identity.name) onEditIdentity({ name: next.name });
        const patch: Partial<AgentDraft> = {};
        if (next.label !== draft.tagline) patch.tagline = next.label;
        if (next.description !== draft.description) patch.description = next.description;
        if (next.avatar !== draft.character) patch.character = next.avatar;
        if (Object.keys(patch).length > 0) onEditDraft(patch);
      }}
    >
      {/* The handle was PROPOSED at creation and may carry a collision suffix nobody chose, so it is
          editable here rather than permanent: a row of the editor's own card, handed in. */}
      <AgentCreatorField label={t('agents.handleLabel')}>
        <TextFieldInput
          label={t('agents.handlePlaceholder')}
          size="sm"
          maxLength={32}
          value={identity.handle}
          onChangeText={(text) => onEditIdentity({ handle: text })}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </AgentCreatorField>
    </AgentCreator>
  );
}