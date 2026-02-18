import React, { useState, useCallback, useEffect, useRef } from 'react';
import { View, ScrollView, Pressable, TextInput, Alert } from 'react-native';
import { Text } from '@/components/ui/text';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { ArrowLeft, X, Trash2 } from 'lucide-react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useTranslation } from '@/hooks/useTranslation';
import { useColorScheme } from '@/lib/useColorScheme';
import { useSkillsStore } from '@/lib/stores/skills-store';
import { toast } from '@/components/sonner';

const SKILL_COLORS = [
  '#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#8b5cf6',
  '#ef4444', '#3b82f6', '#a855f7', '#0ea5e9', '#84cc16',
  '#06b6d4', '#22c55e', '#f97316', '#dc2626', '#e11d48',
];

const CATEGORIES: Array<'featured' | 'community' | 'recent'> = ['featured', 'community', 'recent'];

export default function EditSkillScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const { getSkill, updateSkill, deleteSkill } = useSkillsStore();

  // Loading
  const [loading, setLoading] = useState(true);

  // Form state
  const [title, setTitle] = useState('');
  const [tagline, setTagline] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [icon, setIcon] = useState('');
  const [color, setColor] = useState(SKILL_COLORS[0]);
  const [category, setCategory] = useState<'featured' | 'community' | 'recent'>('community');
  const [language, setLanguage] = useState('en-US');
  const [useCase, setUseCase] = useState('');
  const [triggers, setTriggers] = useState<string[]>([]);
  const [triggerInput, setTriggerInput] = useState('');
  const [includes, setIncludes] = useState<string[]>([]);
  const [includeInput, setIncludeInput] = useState('');
  const [goodAt, setGoodAt] = useState<string[]>([]);
  const [goodAtInput, setGoodAtInput] = useState('');
  const [notGoodAt, setNotGoodAt] = useState<string[]>([]);
  const [notGoodAtInput, setNotGoodAtInput] = useState('');
  const [isPublished, setIsPublished] = useState(false);

  // UI state
  const [saving, setSaving] = useState(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const isInitialLoad = useRef(true);

  // Load skill data
  useEffect(() => {
    if (!id) return;
    setLoading(true);
    getSkill(id).then((skill) => {
      if (skill) {
        setTitle(skill.title);
        setTagline(skill.tagline);
        setDescription(skill.description);
        setIcon(skill.icon);
        setColor(skill.color);
        setCategory(skill.category);
        setLanguage(skill.language);
        setUseCase(skill.useCase || '');
        setTriggers(skill.triggers || []);
        setIncludes(skill.includes || []);
        setGoodAt(skill.goodAt || []);
        setNotGoodAt(skill.notGoodAt || []);
        setIsPublished(skill.isPublished ?? false);
      }
      setLoading(false);
      setTimeout(() => { isInitialLoad.current = false; }, 500);
    });
  }, [id, getSkill]);

  // Load system prompt separately (it's excluded from normal responses)
  useEffect(() => {
    if (!id) return;
    import('@/lib/api/client').then(({ default: apiClient }) => {
      import('@/lib/api/routes').then(({ API_ROUTES }) => {
        apiClient.get(API_ROUTES.skills.prompt(id)).then((res) => {
          if (res.data.systemPrompt) {
            setSystemPrompt(res.data.systemPrompt);
          }
        }).catch(() => {});
      });
    });
  }, [id]);

  // Debounced auto-save
  const debouncedSave = useCallback(
    (updates: Record<string, any>) => {
      if (!id || isInitialLoad.current) return;
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(async () => {
        setSaving(true);
        try {
          await updateSkill(id, updates);
        } catch {
          // silent
        } finally {
          setSaving(false);
        }
      }, 1000);
    },
    [id, updateSkill]
  );

  // Auto-save on field changes
  useEffect(() => {
    debouncedSave({
      title, tagline, description, systemPrompt,
      icon, color, category, language,
      useCase, triggers, includes, goodAt, notGoodAt,
    });
  }, [title, tagline, description, systemPrompt, icon, color, category, language, useCase, triggers, includes, goodAt, notGoodAt, debouncedSave]);

  const addTag = useCallback((input: string, setter: React.Dispatch<React.SetStateAction<string[]>>, clearInput: React.Dispatch<React.SetStateAction<string>>) => {
    const trimmed = input.trim();
    if (trimmed) {
      setter((prev) => prev.includes(trimmed) ? prev : [...prev, trimmed]);
      clearInput('');
    }
  }, []);

  const removeTag = useCallback((tag: string, setter: React.Dispatch<React.SetStateAction<string[]>>) => {
    setter((prev) => prev.filter((t) => t !== tag));
  }, []);

  const handleDelete = useCallback(() => {
    if (!id) return;
    Alert.alert(t('skills.deleteSkill'), t('skills.deleteSkillConfirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('skills.deleteSkill'),
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteSkill(id);
            toast.success(t('skills.deleted'));
            router.back();
          } catch {
            toast.error(t('skills.deleteError'));
          }
        },
      },
    ]);
  }, [id, deleteSkill, router, t]);

  const handlePublishToggle = useCallback(async () => {
    if (!id) return;
    const newValue = !isPublished;
    setIsPublished(newValue);
    try {
      await updateSkill(id, { isPublished: newValue });
      toast.success(newValue ? t('skills.published') : t('skills.draft'));
    } catch {
      setIsPublished(!newValue);
      toast.error(t('skills.createError'));
    }
  }, [id, isPublished, updateSkill, t]);

  if (loading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <Text className="text-muted-foreground">{t('common.loading')}</Text>
      </View>
    );
  }

  function TagInput({
    label,
    value,
    onChangeText,
    tags: tagList,
    onAdd,
    onRemove,
    placeholder,
  }: {
    label: string;
    value: string;
    onChangeText: (v: string) => void;
    tags: string[];
    onAdd: () => void;
    onRemove: (tag: string) => void;
    placeholder: string;
  }) {
    return (
      <View className="gap-1.5">
        <Label>{label}</Label>
        <View className="flex-row items-center gap-2">
          <View className="flex-1">
            <Input
              value={value}
              onChangeText={onChangeText}
              placeholder={placeholder}
              placeholderTextColor={colors.mutedForeground}
              onSubmitEditing={onAdd}
              returnKeyType="done"
            />
          </View>
          <Button size="sm" onPress={onAdd} className="h-9 px-3">
            <Text className="text-xs font-medium text-primary-foreground">+</Text>
          </Button>
        </View>
        {tagList.length > 0 && (
          <View className="flex-row flex-wrap gap-1.5 mt-1">
            {tagList.map((tag) => (
              <Pressable
                key={tag}
                onPress={() => onRemove(tag)}
                className="flex-row items-center gap-1 bg-muted px-2.5 py-1 rounded-full"
              >
                <Text className="text-xs text-foreground">{tag}</Text>
                <X size={12} className="text-muted-foreground" />
              </Pressable>
            ))}
          </View>
        )}
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="flex-row items-center justify-between px-4 py-3 border-b border-border">
        <View className="flex-row items-center gap-3">
          <Pressable onPress={() => router.back()} className="active:opacity-70">
            <ArrowLeft size={20} className="text-foreground" />
          </Pressable>
          <Text className="text-base font-semibold text-foreground">
            {t('skills.editSkill')}
          </Text>
          <View className={`px-2 py-0.5 rounded-full ${isPublished ? 'bg-green-500/15' : 'bg-muted'}`}>
            <Text className={`text-xs font-medium ${isPublished ? 'text-green-500' : 'text-muted-foreground'}`}>
              {isPublished ? t('skills.published') : t('skills.draft')}
            </Text>
          </View>
          {saving && (
            <Text className="text-xs text-muted-foreground">
              {t('common.saving')}
            </Text>
          )}
        </View>
        <View className="flex-row items-center gap-2">
          <Pressable onPress={handleDelete} className="p-2 active:opacity-70">
            <Trash2 size={18} className="text-destructive" />
          </Pressable>
          <Button onPress={handlePublishToggle} className="h-8 px-4 rounded-full">
            <Text className="text-sm font-medium text-primary-foreground">
              {isPublished ? t('skills.unpublish') : t('skills.publish')}
            </Text>
          </Button>
        </View>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ padding: 20, paddingBottom: 60 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Icon + Color */}
        <View className="flex-row gap-4 mb-5">
          <View className="gap-1.5">
            <Label>{t('skills.icon')}</Label>
            <View className="items-center justify-center border border-border rounded-lg" style={{ width: 64, height: 64, backgroundColor: color }}>
              <TextInput
                value={icon}
                onChangeText={setIcon}
                placeholder="🎯"
                placeholderTextColor="rgba(255,255,255,0.4)"
                className="text-center"
                style={{ fontSize: 28, color: '#fff', width: 64, height: 64, textAlign: 'center', textAlignVertical: 'center' }}
                maxLength={2}
              />
            </View>
          </View>
          <View className="flex-1 gap-1.5">
            <Label>{t('skills.color')}</Label>
            <View className="flex-row flex-wrap gap-2">
              {SKILL_COLORS.map((c) => (
                <Pressable
                  key={c}
                  onPress={() => setColor(c)}
                  className="rounded-full"
                  style={{
                    width: 28,
                    height: 28,
                    backgroundColor: c,
                    borderWidth: color === c ? 2 : 0,
                    borderColor: '#fff',
                  }}
                />
              ))}
            </View>
          </View>
        </View>

        {/* Title */}
        <View className="gap-1.5 mb-4">
          <Label>{t('skills.titleLabel')}</Label>
          <Input
            value={title}
            onChangeText={setTitle}
            placeholder={t('skills.titlePlaceholder')}
            placeholderTextColor={colors.mutedForeground}
          />
        </View>

        {/* Tagline */}
        <View className="gap-1.5 mb-4">
          <Label>{t('skills.taglineLabel')}</Label>
          <Input
            value={tagline}
            onChangeText={setTagline}
            placeholder={t('skills.taglinePlaceholder')}
            placeholderTextColor={colors.mutedForeground}
          />
        </View>

        {/* Description */}
        <View className="gap-1.5 mb-4">
          <Label>{t('skills.descriptionLabel')}</Label>
          <Textarea
            value={description}
            onChangeText={setDescription}
            placeholder={t('skills.descriptionPlaceholder')}
            placeholderTextColor={colors.mutedForeground}
            style={{ minHeight: 80 }}
          />
        </View>

        {/* System Prompt */}
        <View className="gap-1.5 mb-4">
          <Label>{t('skills.systemPromptLabel')}</Label>
          <Textarea
            value={systemPrompt}
            onChangeText={setSystemPrompt}
            placeholder={t('skills.systemPromptPlaceholder')}
            placeholderTextColor={colors.mutedForeground}
            style={{ minHeight: 160 }}
          />
        </View>

        {/* Category */}
        <View className="gap-1.5 mb-4">
          <Label>{t('skills.categoryLabel')}</Label>
          <View className="flex-row gap-2">
            {CATEGORIES.map((cat) => (
              <Pressable
                key={cat}
                onPress={() => setCategory(cat)}
                className={`px-3 py-1.5 rounded-full ${category === cat ? 'bg-primary' : 'bg-muted'}`}
              >
                <Text className={`text-xs font-medium capitalize ${category === cat ? 'text-primary-foreground' : 'text-muted-foreground'}`}>
                  {cat}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        {/* Language badge */}
        <View className="gap-1.5 mb-4">
          <Label>{t('skills.languageLabel')}</Label>
          <View className="flex-row">
            <View className="bg-muted px-3 py-1.5 rounded-full">
              <Text className="text-xs font-medium text-muted-foreground uppercase">{language}</Text>
            </View>
          </View>
        </View>

        {/* Use Case */}
        <View className="gap-1.5 mb-4">
          <Label>{t('skills.useCaseLabel')}</Label>
          <Input
            value={useCase}
            onChangeText={setUseCase}
            placeholder={t('skills.useCasePlaceholder')}
            placeholderTextColor={colors.mutedForeground}
          />
        </View>

        {/* Triggers */}
        <View className="mb-4">
          <TagInput
            label={t('skills.triggersLabel')}
            value={triggerInput}
            onChangeText={setTriggerInput}
            tags={triggers}
            onAdd={() => addTag(triggerInput, setTriggers, setTriggerInput)}
            onRemove={(tag) => removeTag(tag, setTriggers)}
            placeholder={t('skills.triggerPlaceholder')}
          />
        </View>

        {/* Includes */}
        <View className="mb-4">
          <TagInput
            label={t('skills.includesLabel')}
            value={includeInput}
            onChangeText={setIncludeInput}
            tags={includes}
            onAdd={() => addTag(includeInput, setIncludes, setIncludeInput)}
            onRemove={(tag) => removeTag(tag, setIncludes)}
            placeholder={t('skills.includePlaceholder')}
          />
        </View>

        {/* Good At */}
        <View className="mb-4">
          <TagInput
            label={t('skills.goodAtLabel')}
            value={goodAtInput}
            onChangeText={setGoodAtInput}
            tags={goodAt}
            onAdd={() => addTag(goodAtInput, setGoodAt, setGoodAtInput)}
            onRemove={(tag) => removeTag(tag, setGoodAt)}
            placeholder={t('skills.goodAtPlaceholder')}
          />
        </View>

        {/* Not Good At */}
        <View className="mb-4">
          <TagInput
            label={t('skills.notGoodAtLabel')}
            value={notGoodAtInput}
            onChangeText={setNotGoodAtInput}
            tags={notGoodAt}
            onAdd={() => addTag(notGoodAtInput, setNotGoodAt, setNotGoodAtInput)}
            onRemove={(tag) => removeTag(tag, setNotGoodAt)}
            placeholder={t('skills.notGoodAtPlaceholder')}
          />
        </View>
      </ScrollView>
    </View>
  );
}
