import { agentTint } from '@/lib/agents/agent-color';
import { AGENT_SWATCHES } from '@/lib/constants/agent-colors';
import type { IdentityDraft } from '@/lib/hooks/agents/use-agent-autosave';
import { useTranslation } from '@/lib/hooks/use-translation';
import { useColorScheme } from '@/lib/useColorScheme';
import { IdentityMark } from '@alia.onl/sdk';
import { Chip, ChipRow } from '@oxy.so/bloom/chip';
import { RiAtLine } from '@oxy.so/bloom/icons';
import { Label } from '@oxy.so/bloom/label';
import {
  TextField,
  TextFieldIcon,
  TextFieldInput as Input,
} from '@oxy.so/bloom/text-field';
import { View } from 'react-native';

/**
 * Mark + Name + Handle, then the colour — all of them the bot ACCOUNT's,
 * saved to Oxy rather than to the agent row.
 */
export function AgentIdentityFields({
  identity,
  onEdit,
}: {
  identity: IdentityDraft;
  onEdit: (patch: Partial<IdentityDraft>) => void;
}) {
  const { t } = useTranslation();
  const { colors } = useColorScheme();

  return (
    <>
      {/* The handle was PROPOSED at creation and may carry a collision suffix
          nobody chose, so it is editable here rather than permanent. */}
      <View className="flex-row items-center gap-3">
        <IdentityMark size={48} color={agentTint(identity.color, colors)} />
        <View className="flex-1 gap-2">
          <Input
            label={t('agents.namePlaceholder')}
            value={identity.name}
            onChangeText={(text) => onEdit({ name: text })}
          />
          <TextField>
            <TextFieldIcon icon={RiAtLine} />
            <Input
              label={t('agents.handlePlaceholder')}
              value={identity.handle}
              onChangeText={(text) => onEdit({ handle: text })}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </TextField>
        </View>
      </View>

      {/* The colour is the agent's whole likeness, so each choice shows
          the MARK rather than a dot standing for one. Only the colours Oxy
          will STORE: the fifty-two presets the `users_color_check`
          constraint omits were a 400 on a swatch the person had just
          picked. */}
      <View className="gap-1.5">
        <Label>{t('agents.colorLabel')}</Label>
        <ChipRow role="radiogroup" accessibilityLabel={t('agents.colorLabel')}>
          {AGENT_SWATCHES.map((preset) => (
            <Chip
              key={preset}
              size="xl"
              role="radio"
              selected={identity.color === preset}
              onPress={() => onEdit({ color: preset })}
              startIcon={
                <IdentityMark size={18} color={agentTint(preset, colors)} />
              }
            >
              {preset}
            </Chip>
          ))}
        </ChipRow>
      </View>
    </>
  );
}
