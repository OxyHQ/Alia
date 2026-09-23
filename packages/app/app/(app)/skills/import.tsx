import { useImportSkill } from '@/lib/hooks/use-skills';
import { useTranslation } from '@/lib/hooks/use-translation';
import { Button } from '@oxy.so/bloom/button';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { RiDownloadLine } from '@oxy.so/bloom/icons/RiDownloadLine';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

/**
 * Importing a skill from a public repository.
 *
 * The same thing `npx skills add` does, and it accepts the same shapes: a
 * repository, a link to one, or a link into a single skill's directory. The
 * import is pinned to the commit it resolved, which is what stops an installed
 * skill from changing under the person using it.
 */

/** Stacking only: the column the page reads in. */
const CONTENT = {
  width: '100%',
  maxWidth: 768,
  alignSelf: 'center',
  paddingHorizontal: 16,
  paddingTop: 16,
  paddingBottom: 48,
  gap: 16,
} as const;
/** Stacking only: a row of actions. */
const ACTIONS = { flexDirection: 'row', alignItems: 'center', gap: 8 } as const;

export default function ImportSkillScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const [source, setSource] = useState('');
  const importSkill = useImportSkill();

  const handleImport = async () => {
    if (!source.trim()) return;
    try {
      const result = await importSkill.mutateAsync({ source: source.trim() });
      toast.success(t('skills.imported', { count: result.skills.length }));
      if (result.rejected.length > 0) {
        toast.info(
          t('skills.importRejected', { count: result.rejected.length }),
        );
      }
      router.replace('/(app)/skills');
    } catch (error) {
      const message = (
        error as { response?: { data?: { error?: { message?: string } } } }
      ).response?.data?.error?.message;
      toast.error(message ?? t('skills.importFailed'));
    }
  };

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={CONTENT}
    >
      <View style={ACTIONS}>
        <Button
          tone="neutral"
          appearance="plain"
          size="sm"
          icon={RiArrowLeftLine}
          accessibilityLabel={t('common.back')}
          onPress={() => router.back()}
        />
      </View>

      <Text variant="title-2-semibold">{t('skills.importTitle')}</Text>
      <Muted>{t('skills.importSubtitle')}</Muted>

      <TextFieldInput
        label={t('skills.importPlaceholder')}
        value={source}
        onChangeText={setSource}
        placeholder={t('skills.importPlaceholder')}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!importSkill.isPending}
      />

      <View style={ACTIONS}>
        <Button
          tone="action"
          leadingIcon={RiDownloadLine}
          loading={importSkill.isPending}
          disabled={importSkill.isPending || !source.trim()}
          onPress={() => void handleImport()}
        >
          {t('skills.import')}
        </Button>
      </View>

      {importSkill.isPending ? <Muted>{t('skills.importing')}</Muted> : null}
    </ScrollView>
  );
}
