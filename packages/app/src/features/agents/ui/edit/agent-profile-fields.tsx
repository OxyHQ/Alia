import type { AgentDraft, IdentityDraft } from '@/features/agents/runtime/use-agent-autosave';
import { useTranslation } from '@/shared/i18n/use-translation';
import { AgentCreator } from '@oxy.so/bloom/agent-creator';
import { RiAtLine } from '@oxy.so/bloom/icons';
import { TextField, TextFieldIcon, TextFieldInput as Input } from '@oxy.so/bloom/text-field';
import { View } from 'react-native';

/**
 * Who the agent is: Bloom's `AgentCreator` for the name, the tagline, the description and the
 * look, and the handle under it.
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
}: {
  id: string;
  identity: IdentityDraft;
  draft: Pick<AgentDraft, 'tagline' | 'description' | 'character'>;
  onEditIdentity: (patch: Partial<IdentityDraft>) => void;
  onEditDraft: (patch: Partial<AgentDraft>) => void;
}) {
  const { t } = useTranslation();

  return (
    <View className="gap-3">
      <AgentCreator
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
      />
      {/* The handle was PROPOSED at creation and may carry a collision suffix
          nobody chose, so it is editable here rather than permanent. */}
      <TextField>
        <TextFieldIcon icon={RiAtLine} />
        <Input
          label={t('agents.handlePlaceholder')}
          value={identity.handle}
          onChangeText={(text) => onEditIdentity({ handle: text })}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </TextField>
    </View>
  );
}
