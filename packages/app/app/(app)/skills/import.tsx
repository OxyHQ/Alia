import { useState } from 'react';
import { View, ScrollView, ActivityIndicator, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ArrowLeft, Download } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { toast } from "@oxyhq/bloom/toast";
import { useTranslation } from '@/lib/hooks/use-translation';
import { useImportSkill } from '@/lib/hooks/use-skills';

/**
 * Importing a skill from a public repository.
 *
 * The same thing `npx skills add` does, and it accepts the same shapes: a
 * repository, a link to one, or a link into a single skill's directory. The
 * import is pinned to the commit it resolved, which is what stops an installed
 * skill from changing under the person using it.
 */

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
        toast.info(t('skills.importRejected', { count: result.rejected.length }));
      }
      router.replace('/(app)/skills');
    } catch (error) {
      const message = (error as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error?.message;
      toast.error(message ?? t('skills.importFailed'));
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
        <Text className="text-2xl font-bold text-foreground mt-2">{t('skills.importTitle')}</Text>
        <Text className="text-[13px] text-muted-foreground mt-1">{t('skills.importSubtitle')}</Text>

        <Input
          value={source}
          onChangeText={setSource}
          placeholder={t('skills.importPlaceholder')}
          autoCapitalize="none"
          autoCorrect={false}
          className="mt-5"
          editable={!importSkill.isPending}
        />

        <Button className="mt-4 rounded-full" disabled={importSkill.isPending || !source.trim()} onPress={handleImport}>
          {importSkill.isPending ? (
            <ActivityIndicator size="small" />
          ) : (
            <>
              <Download size={14} className="text-primary-foreground" />
              <Text className="ml-1.5">{t('skills.import')}</Text>
            </>
          )}
        </Button>

        {importSkill.isPending ? (
          <Text className="text-[12px] text-muted-foreground mt-2 text-center">{t('skills.importing')}</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}
