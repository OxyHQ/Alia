import {
  useCreateSkillVersion,
  useDeleteSkill,
  useSkill,
  useUpdateSkill,
} from '@/lib/hooks/use-skills';
import { useTranslation } from '@/lib/hooks/use-translation';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Field } from '@oxy.so/bloom/field';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { Loading } from '@oxy.so/bloom/loading';
import {
  SettingsListGroup,
  SettingsListItem,
} from '@oxy.so/bloom/settings-list';
import { Switch } from '@oxy.so/bloom/switch';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';

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
/** Stacking only: the top row, back on one side and saving on the other. */
const ACTIONS = {
  flexDirection: 'row',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 8,
} as const;
const ROW = { flexDirection: 'row', gap: 8 } as const;

export default function EditSkillScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { t } = useTranslation();
  const { colors } = useTheme();

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

  if (detail.isLoading) {
    return <Loading variant="spinner" />;
  }

  if (!detail.data) {
    return (
      <EmptyState
        title={t('skills.notFound')}
        action={{ label: t('common.back'), onPress: () => router.back() }}
      />
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
          allowedTools: allowedTools.trim()
            ? allowedTools.trim().split(/\s+/)
            : undefined,
        },
      });
      if (result.unchanged) toast.info(t('skills.versionUnchanged'));
      else
        toast.success(
          t('skills.versionSaved', { version: result.version?.version ?? '' }),
        );
    } catch (error) {
      const message = (
        error as { response?: { data?: { error?: { message?: string } } } }
      ).response?.data?.error?.message;
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
        <View style={ROW}>
          <Button
            size="sm"
            tone="neutral"
            appearance="subtle"
            disabled={patch.isPending}
            onPress={savePresentation}
          >
            {t('skills.save')}
          </Button>
          <Button
            size="sm"
            tone="action"
            disabled={!documentChanged || newVersion.isPending}
            onPress={saveVersion}
          >
            {t('skills.saveVersion')}
          </Button>
        </View>
      </View>

      <Field label={t('skills.nameLabel')} description={t('skills.nameHint')}>
        <Text variant="body-regular" selectable>
          {skill.name}
        </Text>
      </Field>

      <Field label={t('skills.displayNameLabel')}>
        <TextFieldInput
          label={t('skills.displayNameLabel')}
          placeholder={null}
          value={displayName}
          onChangeText={setDisplayName}
        />
      </Field>

      {/* The server refuses a description over 1024 characters, so the field
          stops there and counts toward it. */}
      <Textarea
        label={t('skills.descriptionLabel')}
        hint={t('skills.descriptionHint')}
        value={description}
        onChangeText={setDescription}
        autoResize
        rows={5}
        maxLength={1024}
        showCount
      />

      <Textarea
        label={t('skills.bodyLabel')}
        hint={t('skills.bodyHint')}
        value={body}
        onChangeText={setBody}
        autoResize
        rows={13}
      />

      <Field label={t('skills.licenseLabel')}>
        <TextFieldInput
          label={t('skills.licenseLabel')}
          value={license}
          onChangeText={setLicense}
          placeholder="Apache-2.0"
          autoCapitalize="none"
        />
      </Field>

      <Field label={t('skills.compatibilityLabel')}>
        <TextFieldInput
          label={t('skills.compatibilityLabel')}
          placeholder={null}
          value={compatibility}
          onChangeText={setCompatibility}
        />
      </Field>

      <Field label={t('skills.allowedToolsLabel')}>
        <TextFieldInput
          label={t('skills.allowedToolsLabel')}
          placeholder={null}
          value={allowedTools}
          onChangeText={setAllowedTools}
          autoCapitalize="none"
        />
      </Field>

      <SettingsListGroup>
        <SettingsListItem
          title={t('skills.publish')}
          description={t('skills.publishHint')}
          rightElement={
            <Switch
              accessibilityLabel={t('skills.publish')}
              value={isPublic}
              onValueChange={setIsPublic}
            />
          }
        />
      </SettingsListGroup>

      <SettingsListGroup>
        <SettingsListItem
          icon={<RiDeleteBinLine width={18} height={18} fill={colors.error} />}
          title={
            confirmingDelete
              ? t('skills.deleteSkillConfirm')
              : t('skills.deleteSkill')
          }
          destructive
          showChevron={false}
          disabled={remove.isPending}
          onPress={() =>
            confirmingDelete ? void handleDelete() : setConfirmingDelete(true)
          }
        />
      </SettingsListGroup>
    </ScrollView>
  );
}
