import { Composer } from '@/features/chat/ui/composer/composer';
import { useAliaComposer } from '@/features/chat/ui/composer/use-alia-composer';
import { useCreateSkill, useGenerateSkillDraft } from '@/features/skills/runtime/use-skills';
import { useTranslation } from '@/shared/i18n/use-translation';
import { useI18nStore } from '@/shared/i18n/i18n-store';
import { toast } from '@oxy.so/bloom/toast';
import { Muted } from '@oxy.so/bloom/typography';
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView } from 'react-native';
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
  const composer = useAliaComposer({
    draft: 'surface:skill-create',
    locked: busy,
    // `/skills/generate` reads the prompt and nothing else — no model, effort, mode,
    // file, skill or connector — so the composer offers none of them.
    promptOnly: true,
  });

  const handleCreate = async () => {
    if (prompt.trim().length < 10) return;
    try {
      const drafted = await draft.mutateAsync({
        prompt: prompt.trim(),
        language: locale,
      });
      const skill = await create.mutateAsync({ document: drafted.document });
      toast.success(t('skills.created'));
      router.replace(`/(app)/skills/edit/${skill._id}`);
    } catch (error) {
      const message = (
        error as { response?: { data?: { error?: { message?: string } } } }
      ).response?.data?.error?.message;
      toast.error(message ?? t('skills.generateFailed'));
    }
  };

  return (
    <>
      <Stack.Screen
        options={{ title: t('skills.createTitle'), headerBackVisible: true }}
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="w-full max-w-[768px] self-center gap-4 px-4 pb-12 pt-4"
      >
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
    </>
  );
}
