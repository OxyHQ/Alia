import type { LinkedSkill } from '@/lib/hooks/agents/use-agent-autosave';
import { unlinkedSkills } from '@/lib/hooks/agents/use-agent-editor-options';
import { useIsLargeScreen } from '@/lib/hooks/use-is-large-screen';
import { useTranslation } from '@/lib/hooks/use-translation';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Item } from '@oxy.so/bloom/item';
import { Search } from '@oxy.so/bloom/search';
import { Text } from '@oxy.so/bloom/typography';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

/** Pick one more skill for the agent from the ones it does not have yet. */
export function SkillPickerDialog({
  open,
  onClose,
  skills,
  linked,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  /** Every skill the agent could be given. */
  skills: readonly LinkedSkill[];
  /** The ones it already has, which the list leaves out. */
  linked: readonly LinkedSkill[];
  onPick: (skill: LinkedSkill) => void;
}) {
  const { t } = useTranslation();
  const isLargeScreen = useIsLargeScreen();
  const [search, setSearch] = useState('');

  return (
    <Dialog
      open={open}
      onClose={onClose}
      placement={{ base: 'bottom', md: 'center' }}
      title={t('agents.skills')}
      // The picker owns its own ScrollView and its own padding.
      scrollable={false}
      contentPadding={0}
    >
      <View className="px-4 pb-2">
        <Search
          label={t('agents.searchSkills')}
          value={search}
          onChangeText={setSearch}
          onClearText={() => setSearch('')}
          autoFocus
        />
      </View>
      <ScrollView className={isLargeScreen ? 'max-h-[300px]' : 'flex-1'}>
        {unlinkedSkills(skills, linked, search).map((skill) => (
          <Item
            key={skill._id}
            role="option"
            onPress={() => {
              onPick(skill);
              onClose();
              setSearch('');
            }}
            leading={<Text>{skill.icon ?? '\u{1F9E9}'}</Text>}
            title={skill.displayName}
          />
        ))}
      </ScrollView>
    </Dialog>
  );
}
