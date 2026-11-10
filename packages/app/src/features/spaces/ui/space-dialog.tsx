import { agentDisplayName } from '@/features/agents/model/identity';
import { spaceErrorCode } from '@/features/spaces/runtime/use-spaces';
import type { Agent } from '@/shared/contracts/agents';
import {
  SPACE_BRIEF_MAX,
  SPACE_MAX_AGENTS,
  SPACE_NAME_MAX,
  type Space,
} from '@/shared/contracts/spaces';
import { useTranslation } from '@/shared/i18n/use-translation';
import { useKeyboardOnOpen } from '@/shared/platform/use-keyboard-on-open';
import { readAgentCharacter } from '@alia.onl/sdk';
import { AgentAvatar } from '@oxy.so/bloom/agent-avatar';
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import { toast } from '@oxy.so/bloom/toast';
import { Muted } from '@oxy.so/bloom/typography';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

/**
 * What the space dialog is doing: making a space (name, brief and its first agents), renaming one,
 * rewriting its brief, or adding agents to it. `null` is closed.
 */
export type SpaceDialogState =
  | { mode: 'create' }
  | { mode: 'rename'; space: Space }
  | { mode: 'brief'; space: Space }
  | { mode: 'addAgents'; space: Space }
  | null;

/** What the dialog hands back: only the fields its mode asks for. */
export interface SpaceDialogValues {
  name?: string;
  instructions?: string;
  agentIds?: string[];
}

const TITLES = {
  create: 'spaces.createTitle',
  rename: 'spaces.renameTitle',
  brief: 'spaces.briefTitle',
  addAgents: 'spaces.addAgentsTitle',
} as const;

/** The sentence for a refused space request: the full-space 409 says so, anything else is generic. */
export function spaceFailureMessage(error: unknown, t: (key: string, params?: object) => string) {
  const code = spaceErrorCode(error);
  if (code === 'space_full') return t('spaces.full', { count: SPACE_MAX_AGENTS });
  if (code === 'agent_in_other_space') return t('spaces.inOtherSpace');
  return t('spaces.saveFailed');
}

/**
 * Make or change a space, as the group picker makes a group: the dialog asks only what the mode
 * needs. The agents offered (`candidates`) are the person's own that are in no space yet, and the
 * picker holds at most the seats the space has left. `onSubmit` rejects when the API refuses (the
 * dialog stays open and says why).
 */
export function SpaceDialog({
  state,
  candidates,
  onClose,
  onSubmit,
}: {
  state: SpaceDialogState;
  candidates: readonly Agent[];
  onClose: () => void;
  onSubmit: (state: NonNullable<SpaceDialogState>, values: SpaceDialogValues) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [brief, setBrief] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const nameInput = useKeyboardOnOpen(state !== null);

  useEffect(() => {
    if (!state) return;
    setName(state.mode === 'rename' ? state.space.name : '');
    setBrief(state.mode === 'brief' ? state.space.instructions : '');
    setSelected([]);
    setBusy(false);
  }, [state]);

  const mode = state?.mode;
  const seats =
    state?.mode === 'addAgents'
      ? SPACE_MAX_AGENTS - state.space.memberAgentIds.length
      : SPACE_MAX_AGENTS;
  const trimmedName = name.trim();
  const trimmedBrief = brief.trim();
  const asksName = mode === 'create' || mode === 'rename';
  const asksBrief = mode === 'create' || mode === 'brief';
  const asksAgents = mode === 'create' || mode === 'addAgents';

  const unchanged =
    (state?.mode === 'rename' && trimmedName === state.space.name) ||
    (state?.mode === 'brief' && trimmedBrief === state.space.instructions.trim()) ||
    (state?.mode === 'addAgents' && selected.length === 0);
  const invalid =
    (asksName && (trimmedName.length === 0 || trimmedName.length > SPACE_NAME_MAX)) ||
    (asksBrief && trimmedBrief.length > SPACE_BRIEF_MAX);

  const toggle = (id: string) =>
    setSelected((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : ids.length < seats ? [...ids, id] : ids,
    );

  const submit = async () => {
    if (!state || invalid || unchanged || busy) return;
    // The strict body: only what the mode asks for, and no empty optional field.
    const values: SpaceDialogValues = {};
    if (asksName) values.name = trimmedName;
    if (mode === 'brief') values.instructions = trimmedBrief;
    if (mode === 'create' && trimmedBrief) values.instructions = trimmedBrief;
    if (asksAgents && selected.length > 0) values.agentIds = selected;
    setBusy(true);
    try {
      await onSubmit(state, values);
      onClose();
    } catch (error) {
      toast.error(spaceFailureMessage(error, t));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={state !== null}
      onClose={onClose}
      placement={{ base: 'bottom', md: 'center' }}
      title={t(TITLES[mode ?? 'create'])}
      actions={[
        { label: t('common.cancel'), color: 'cancel' },
        {
          label: t(mode === 'create' ? 'common.create' : 'common.save'),
          disabled: invalid || unchanged || busy,
          shouldCloseOnPress: false,
          onPress: () => void submit(),
        },
      ]}
    >
      <View className="gap-4">
        {asksName ? (
          <TextFieldInput
            label={t('spaces.name')}
            value={name}
            onValueChange={setName}
            onSubmitEditing={mode === 'rename' ? () => void submit() : undefined}
            maxLength={SPACE_NAME_MAX}
            selectTextOnFocus
            autoFocus
            inputRef={nameInput}
          />
        ) : null}
        {asksBrief ? (
          <Textarea
            label={t('spaces.brief')}
            value={brief}
            onChangeText={setBrief}
            placeholder={t('spaces.briefPlaceholder')}
            hint={t('spaces.briefHint')}
            maxLength={SPACE_BRIEF_MAX}
            rows={3}
          />
        ) : null}
        {asksAgents ? (
          <View className="gap-2">
            <Muted>{t('spaces.chooseAgents', { count: seats })}</Muted>
            {candidates.length === 0 ? (
              <Muted>{t('spaces.noFreeAgents')}</Muted>
            ) : (
              <View
                className="flex-row flex-wrap gap-2"
                accessibilityRole="menu"
                accessibilityLabel={t('spaces.chooseAgents', { count: seats })}
              >
                {candidates.map((agent) => (
                  <Button
                    key={agent._id}
                    appearance="plain"
                    tone="neutral"
                    size="sm"
                    pressed={selected.includes(agent._id)}
                    accessibilityLabel={agentDisplayName(agent)}
                    leading={
                      <AgentAvatar
                        character={readAgentCharacter(agent.character)}
                        size={20}
                        portrait
                      />
                    }
                    onPress={() => toggle(agent._id)}
                  >
                    {agentDisplayName(agent)}
                  </Button>
                ))}
              </View>
            )}
          </View>
        ) : null}
      </View>
    </Dialog>
  );
}
