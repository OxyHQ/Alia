import { useEffect, useState } from 'react';
import { View, ScrollView, ActivityIndicator, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { ArrowLeft, Trash2 } from 'lucide-react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { toast } from "@oxyhq/bloom/toast";
import { useTranslation } from '@/lib/hooks/use-translation';
import {
  useCreateSkillVersion,
  useDeleteSkill,
  useSkill,
  useUpdateSkill,
} from '@/lib/hooks/use-skills';

/**
 * Editing a skill.
 *
 * Two kinds of change, and the screen keeps them apart because the model does:
 *
 *  - **Presentation** — display name, tags, visibility — is a patch. It changes
 *    how the skill is listed and nothing about what it tells Alia to do.
 *  - **The document** — description, instructions, licence, requirements — is a
 *    new VERSION. Somebody may have pinned the version they installed, and an
 *    in-place edit would move the ground under them.
 *
 * `name` is not editable at all: it is what Alia says to load the skill, and
 * changing it makes a different skill rather than editing this one.
 */

export default function EditSkillScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { t } = useTranslation();

  const detail = useSkill(id);
  const patch = useUpdateSkill();
  const newVersion = useCreateSkillVersion();
  const remove = useDeleteSkill();

  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [license, setLicense] = useState('');
  const [compatibility, setCompatibility] = useState('');
  const [allowedTools, setAllowedTools] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [loaded, setLoaded] = useState(false);
  /**
   * Deleting takes two presses.
   *
   * `confirm()` exists on web only and React Native's `Alert` is a no-op there,
   * so neither is a confirmation this screen can rely on. Asking in the button
   * itself works on every platform and cannot be dismissed by accident.
   */
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Load once. A refetch while somebody is typing must not overwrite what they
  // typed, which is what a `useEffect` keyed on the query data would do on every
  // background refresh.
  useEffect(() => {
    if (loaded || !detail.data) return;
    const { skill, version } = detail.data;
    setDisplayName(skill.displayName);
    setDescription(skill.description);
    setBody(version?.body ?? '');
    setLicense(skill.license ?? '');
    setCompatibility(skill.compatibility ?? '');
    setAllowedTools(skill.allowedTools.join(' '));
    setIsPublic(skill.visibility === 'public');
    setLoaded(true);
  }, [detail.data, loaded]);

  if (detail.isLoading || !detail.data) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        {detail.isLoading ? <ActivityIndicator /> : <Text className="text-muted-foreground">{t('skills.notFound')}</Text>}
      </View>
    );
  }

  const { skill, version } = detail.data;
  const documentChanged =
    description !== skill.description ||
    body !== (version?.body ?? '') ||
    license !== (skill.license ?? '') ||
    compatibility !== (skill.compatibility ?? '') ||
    allowedTools !== skill.allowedTools.join(' ');

  const savePresentation = async () => {
    try {
      await patch.mutateAsync({
        id: skill._id,
        patch: { displayName, visibility: isPublic ? 'public' : 'private' },
      });
      toast.success(t('skills.saved'));
    } catch {
      toast.error(t('skills.saveFailed'));
    }
  };

  const saveVersion = async () => {
    try {
      const result = await newVersion.mutateAsync({
        id: skill._id,
        input: {
          name: skill.name,
          description,
          body,
          license: license.trim() || undefined,
          compatibility: compatibility.trim() || undefined,
          allowedTools: allowedTools.trim() ? allowedTools.trim().split(/\s+/) : undefined,
        },
      });
      if (result.unchanged) toast.info(t('skills.versionUnchanged'));
      else toast.success(t('skills.versionSaved', { version: result.version?.version ?? '' }));
    } catch (error) {
      const message = (error as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error?.message;
      toast.error(message ?? t('skills.saveFailed'));
    }
  };

  const handleDelete = async () => {
    try {
      await remove.mutateAsync(skill._id);
      toast.success(t('skills.deleted'));
      router.replace('/(app)/skills');
    } catch {
      toast.error(t('skills.deleteError'));
    }
  };

  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center justify-between px-4 pt-4">
        <Pressable onPress={() => router.back()} className="h-9 w-9 items-center justify-center rounded-full active:bg-muted">
          <ArrowLeft size={18} className="text-foreground" />
        </Pressable>
        <View className="flex-row gap-2">
          <Button size="sm" variant="outline" className="rounded-full" disabled={patch.isPending} onPress={savePresentation}>
            <Text>{t('skills.save')}</Text>
          </Button>
          <Button size="sm" className="rounded-full" disabled={!documentChanged || newVersion.isPending} onPress={saveVersion}>
            <Text>{t('skills.saveVersion')}</Text>
          </Button>
        </View>
      </View>

      <ScrollView className="flex-1 px-5" showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <View className="gap-4 pt-4 pb-10">
          <View className="gap-1.5">
            <Label>{t('skills.nameLabel')}</Label>
            <Text className="text-[13px] text-foreground">{skill.name}</Text>
            <Text className="text-[11px] text-muted-foreground">{t('skills.nameHint')}</Text>
          </View>

          <View className="gap-1.5">
            <Label>{t('skills.displayNameLabel')}</Label>
            <Input value={displayName} onChangeText={setDisplayName} />
          </View>

          <View className="gap-1.5">
            <Label>{t('skills.descriptionLabel')}</Label>
            <Textarea value={description} onChangeText={setDescription} multiline className="min-h-[90px]" />
            <Text className="text-[11px] text-muted-foreground">{t('skills.descriptionHint')}</Text>
            <Text className="text-[11px] text-muted-foreground">{description.length} / 1024</Text>
          </View>

          <View className="gap-1.5">
            <Label>{t('skills.bodyLabel')}</Label>
            <Textarea value={body} onChangeText={setBody} multiline className="min-h-[260px]" />
            <Text className="text-[11px] text-muted-foreground">{t('skills.bodyHint')}</Text>
          </View>

          <View className="gap-1.5">
            <Label>{t('skills.licenseLabel')}</Label>
            <Input value={license} onChangeText={setLicense} placeholder="Apache-2.0" autoCapitalize="none" />
          </View>

          <View className="gap-1.5">
            <Label>{t('skills.compatibilityLabel')}</Label>
            <Input value={compatibility} onChangeText={setCompatibility} />
          </View>

          <View className="gap-1.5">
            <Label>{t('skills.allowedToolsLabel')}</Label>
            <Input value={allowedTools} onChangeText={setAllowedTools} autoCapitalize="none" />
          </View>

          <View className="flex-row items-center justify-between">
            <View className="flex-1 pr-4">
              <Text className="text-[14px] text-foreground">{t('skills.publish')}</Text>
              <Text className="text-[12px] text-muted-foreground mt-0.5">{t('skills.publishHint')}</Text>
            </View>
            <Switch value={isPublic} onValueChange={setIsPublic} />
          </View>

          <Pressable
            className="flex-row items-center gap-2 py-3 active:opacity-70"
            onPress={() => (confirmingDelete ? void handleDelete() : setConfirmingDelete(true))}
            disabled={remove.isPending}
          >
            <Trash2 size={14} className="text-destructive" />
            <Text className="text-[13px] text-destructive flex-1">
              {confirmingDelete ? t('skills.deleteSkillConfirm') : t('skills.deleteSkill')}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}
