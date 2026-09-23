import { Composer } from '@/components/chat/composer/composer';
import { useAliaComposer } from '@/components/chat/composer/use-alia-composer';
import { useCreateSkill, useGenerateSkillDraft } from '@/lib/hooks/use-skills';
import { useTranslation } from '@/lib/hooks/use-translation';
import { useI18nStore } from '@/lib/stores/i18n-store';
import { Button } from '@oxy.so/bloom/button';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { toast } from '@oxy.so/bloom/toast';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
/**
 * Writing a skill, starting from a sentence.
 *
 * The model drafts a real `SKILL.md` — frontmatter and instructions — and the
 * draft is SAVED as written, then opened in the editor. What it does not do is
 * invent a dozen fields the format has no place for, which is what the previous
 * version of this screen produced: thirteen values, of which one was ever read.
 */

export default function CreateSkillScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const locale = useI18nStore((state) => state.locale);
  const [prompt, setPrompt] = useState('');

  const draft = useGenerateSkillDraft();
  const create = useCreateSkill();
  const busy = draft.isPending || create.isPending;
  const composer = useAliaComposer({ locked: busy });

  const handleCreate = async () => {
    if (prompt.trim().length < 10) return;
    try {
      const drafted = await draft.mutateAsync({ prompt: prompt.trim(), language: locale });
      const skill = await create.mutateAsync({ document: drafted.document });
      toast.success(t('skills.created'));
      router.replace(`/(app)/skills/edit/${skill._id}`);
    } catch (error) {
      const message = (error as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error?.message;
      toast.error(message ?? t('skills.generateFailed'));
    }
  };

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerClassName="w-full max-w-[768px] self-center gap-4 px-4 pb-12 pt-4"
    >
      <View className="flex-row items-center gap-2">
        <Button
          tone="neutral"
          appearance="plain"
          size="sm"
          icon={RiArrowLeftLine}
          accessibilityLabel={t('common.back')}
          onPress={() => router.back()}
        />
      </View>

      <Text variant="title-2-semibold">{t('skills.createTitle')}</Text>
      <Muted>{t('skills.createSubtitle')}</Muted>

      {/* The chat's own composer: describing a skill is the same gesture as
          asking Alia anything. The ten-character floor stays in the handler. */}
      <Composer
        {...composer.props}
        value={prompt}
        onValueChange={setPrompt}
        onSubmit={() => void handleCreate()}
        busy={busy}
        disabled={busy}
        placeholder={t('skills.createPlaceholder')}
      />

      {busy ? <Muted>{t('skills.generating')}</Muted> : null}
    </ScrollView>
  );
}
