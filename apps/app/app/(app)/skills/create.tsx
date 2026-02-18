import React, { useState, useCallback } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { PromptInput } from '@/components/ui/prompt-input';
import { useRouter } from 'expo-router';
import { useSkillsStore } from '@/lib/stores/skills-store';
import { useTranslation } from '@/hooks/useTranslation';
import { useI18nStore } from '@/lib/stores/i18n-store';
import { toast } from '@/components/sonner';
import apiClient from '@/lib/api/client';
import { API_ROUTES } from '@/lib/api/routes';

export default function CreateSkillScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const locale = useI18nStore((s) => s.locale);
  const createSkill = useSkillsStore((s) => s.createSkill);

  const [inputValue, setInputValue] = useState('');
  const [generating, setGenerating] = useState(false);

  const language = locale.split('-')[0];

  const handleGenerate = useCallback(async () => {
    if (!inputValue.trim() || generating) return;
    setGenerating(true);

    try {
      // Step 1: AI generates skill config from prompt
      const genRes = await apiClient.post(API_ROUTES.skills.generate, {
        prompt: inputValue.trim(),
        language,
      });
      const config = genRes.data;

      // Step 2: Create the skill
      const skill = await createSkill({
        ...config,
      });

      if (skill) {
        toast.success(t('skills.created'));
        router.replace(`/(app)/skills/edit/${skill.skillId}` as any);
      } else {
        toast.error(t('skills.createError'));
      }
    } catch (error: any) {
      const message = error?.response?.data?.error || t('skills.createError');
      toast.error(message);
    } finally {
      setGenerating(false);
    }
  }, [inputValue, generating, language, createSkill, router, t]);

  if (generating) {
    return (
      <View className="flex-1 bg-background items-center justify-center gap-4">
        <ActivityIndicator size="large" />
        <Text className="text-base text-muted-foreground">
          {t('skills.generating')}
        </Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background items-center justify-center px-5">
      <View className="w-full max-w-2xl gap-6">
        <Text className="text-2xl font-semibold text-foreground text-center">
          {t('skills.createTitle')}
        </Text>

        <PromptInput
          value={inputValue}
          onValueChange={setInputValue}
          onSubmit={handleGenerate}
          isLoading={generating}
          disabled={generating}
          placeholder={t('skills.createPlaceholder')}
          autocomplete
          autocompletePosition="bottom"
        />
      </View>
    </View>
  );
}
