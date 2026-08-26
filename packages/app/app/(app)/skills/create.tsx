import { useState } from 'react';
import { View, ScrollView, ActivityIndicator, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ArrowLeft, Sparkles } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { toast } from "@oxyhq/bloom/toast";
import { useTranslation } from '@/lib/hooks/use-translation';
import { useI18nStore } from '@/lib/stores/i18n-store';
import { useCreateSkill, useGenerateSkillDraft } from '@/lib/hooks/use-skills';

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
    <View className="flex-1 bg-background">
      <View className="flex-row items-center px-4 pt-4">
        <Pressable onPress={() => router.back()} className="h-9 w-9 items-center justify-center rounded-full active:bg-muted">
          <ArrowLeft size={18} className="text-foreground" />
        </Pressable>
      </View>

      <ScrollView className="flex-1 px-5" showsVerticalScrollIndicator={false}>
        <Text className="text-2xl font-bold text-foreground mt-2">{t('skills.createTitle')}</Text>
        <Text className="text-[13px] text-muted-foreground mt-1">{t('skills.createSubtitle')}</Text>

        <Textarea
          value={prompt}
          onChangeText={setPrompt}
          placeholder={t('skills.createPlaceholder')}
          className="mt-5 min-h-[140px]"
          editable={!busy}
          multiline
        />

        <Button className="mt-4 rounded-full" disabled={busy || prompt.trim().length < 10} onPress={handleCreate}>
          {busy ? (
            <ActivityIndicator size="small" />
          ) : (
            <>
              <Sparkles size={14} className="text-primary-foreground" />
              <Text className="ml-1.5">{t('skills.generate')}</Text>
            </>
          )}
        </Button>

        {busy ? <Text className="text-[12px] text-muted-foreground mt-2 text-center">{t('skills.generating')}</Text> : null}
      </ScrollView>
    </View>
  );
}
