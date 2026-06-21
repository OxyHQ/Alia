import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  ScrollView,
  Pressable,
  TextInput,
  Alert,
  useWindowDimensions,
} from 'react-native';
import { Text } from '@/components/ui/text';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import * as DropdownMenu from '@/components/ui/dropdown-menu';
import { SkillCover } from '@/components/ui/skill-cover';
import {
  ArrowLeft,
  X,
  Plus,
  Ellipsis,
  Settings,
  ChevronRight,
  Zap,
  List,
  ThumbsUp,
  ThumbsDown,
} from 'lucide-react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useTranslation } from '@/hooks/useTranslation';
import { useColorScheme } from '@/lib/useColorScheme';
import { useSkillsStore } from '@/lib/stores/skills-store';
import { toast } from '@/components/sonner';
import { cn } from '@/lib/utils';

const SKILL_COLORS = [
  '#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#8b5cf6',
  '#ef4444', '#3b82f6', '#a855f7', '#0ea5e9', '#84cc16',
  '#06b6d4', '#22c55e', '#f97316', '#dc2626', '#e11d48',
];

const CATEGORIES: Array<'featured' | 'community' | 'recent'> = ['featured', 'community', 'recent'];

type SidebarTab = 'content' | 'settings';

export default function EditSkillScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const { width } = useWindowDimensions();
  const isLargeScreen = width >= 768;
  const { getSkill, updateSkill, deleteSkill } = useSkillsStore();

  // Loading
  const [loading, setLoading] = useState(true);

  // Form state
  const [title, setTitle] = useState('');
  const [tagline, setTagline] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
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
  const [showPanel, setShowPanel] = useState(isLargeScreen);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('content');
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
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

  // Load system prompt separately
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
      color, category, language,
      useCase, triggers, includes, goodAt, notGoodAt,
    });
  }, [title, tagline, description, systemPrompt, color, category, language, useCase, triggers, includes, goodAt, notGoodAt, debouncedSave]);

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

  // ─── Tag list section (reusable for triggers, includes, goodAt, notGoodAt) ──
  function TagListSection({
    icon: Icon,
    label,
    items,
    inputValue,
    onChangeInput,
    onAdd,
    onRemove,
    placeholder,
  }: {
    icon: React.ComponentType<any>;
    label: string;
    items: string[];
    inputValue: string;
    onChangeInput: (v: string) => void;
    onAdd: () => void;
    onRemove: (tag: string) => void;
    placeholder: string;
  }) {
    const [showInput, setShowInput] = useState(false);
    return (
      <View className={cn(isLargeScreen && 'flex-1', 'border-b border-border')}>
        <View className="px-4 pt-4 pb-2 flex-row items-center justify-between">
          <View className="flex-row items-center gap-2">
            <Icon size={16} className="text-foreground" />
            <Text className="text-sm font-semibold text-foreground">{label}</Text>
          </View>
          <Pressable
            onPress={() => setShowInput(!showInput)}
            className="active:opacity-70"
          >
            <Plus size={16} className="text-muted-foreground" />
          </Pressable>
        </View>
        <View className="px-4 pb-4 gap-2">
          {showInput && (
            <View className="flex-row items-center gap-2">
              <TextInput
                value={inputValue}
                onChangeText={onChangeInput}
                placeholder={placeholder}
                placeholderTextColor={colors.mutedForeground}
                className="flex-1 text-sm text-foreground border border-border rounded-md px-3 py-1.5"
                onSubmitEditing={() => {
                  onAdd();
                  if (!inputValue.trim()) setShowInput(false);
                }}
                autoFocus
                returnKeyType="done"
              />
            </View>
          )}
          {items.map((item) => (
            <View key={item} className="flex-row items-center justify-between py-1.5">
              <Text className="text-sm text-foreground flex-1" numberOfLines={1}>{item}</Text>
              <Pressable onPress={() => onRemove(item)} className="active:opacity-70 ml-2">
                <X size={14} className="text-muted-foreground" />
              </Pressable>
            </View>
          ))}
        </View>
      </View>
    );
  }

  // ─── Sidebar content ────────────────────────────────────────────────────────
  const sidebarContent = (
    <View className="flex-1 bg-background">
      {/* Sidebar Header */}
      <View className="flex-row items-center justify-between px-4 py-3 border-b border-border">
        <Text className="text-base font-semibold text-foreground">
          {sidebarTab === 'content' ? t('skills.content') : t('skills.settings')}
        </Text>
        {!isLargeScreen && (
          <Pressable className="p-1 rounded-lg active:opacity-70" onPress={() => setShowPanel(false)}>
            <X size={20} className="text-muted-foreground" />
          </Pressable>
        )}
      </View>

      {/* Tabs */}
      <View className="flex-row border-b border-border">
        <Pressable
          onPress={() => setSidebarTab('content')}
          className={cn('flex-1 py-2.5 items-center', sidebarTab === 'content' && 'border-b-2 border-primary')}
        >
          <Text className={cn('text-sm font-medium', sidebarTab === 'content' ? 'text-foreground' : 'text-muted-foreground')}>
            {t('skills.content')}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setSidebarTab('settings')}
          className={cn('flex-1 py-2.5 items-center', sidebarTab === 'settings' && 'border-b-2 border-primary')}
        >
          <Text className={cn('text-sm font-medium', sidebarTab === 'settings' ? 'text-foreground' : 'text-muted-foreground')}>
            {t('skills.settings')}
          </Text>
        </Pressable>
      </View>

      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        scrollEnabled={!isLargeScreen}
        contentContainerStyle={isLargeScreen ? { flex: 1 } : undefined}
      >
        {sidebarTab === 'content' ? (
          <View className={isLargeScreen ? 'flex-1' : ''}>
            <TagListSection
              icon={Zap}
              label={t('skills.triggersLabel')}
              items={triggers}
              inputValue={triggerInput}
              onChangeInput={setTriggerInput}
              onAdd={() => addTag(triggerInput, setTriggers, setTriggerInput)}
              onRemove={(tag) => removeTag(tag, setTriggers)}
              placeholder={t('skills.triggerPlaceholder')}
            />
            <TagListSection
              icon={List}
              label={t('skills.includesLabel')}
              items={includes}
              inputValue={includeInput}
              onChangeInput={setIncludeInput}
              onAdd={() => addTag(includeInput, setIncludes, setIncludeInput)}
              onRemove={(tag) => removeTag(tag, setIncludes)}
              placeholder={t('skills.includePlaceholder')}
            />
            <TagListSection
              icon={ThumbsUp}
              label={t('skills.goodAtLabel')}
              items={goodAt}
              inputValue={goodAtInput}
              onChangeInput={setGoodAtInput}
              onAdd={() => addTag(goodAtInput, setGoodAt, setGoodAtInput)}
              onRemove={(tag) => removeTag(tag, setGoodAt)}
              placeholder={t('skills.goodAtPlaceholder')}
            />
            <TagListSection
              icon={ThumbsDown}
              label={t('skills.notGoodAtLabel')}
              items={notGoodAt}
              inputValue={notGoodAtInput}
              onChangeInput={setNotGoodAtInput}
              onAdd={() => addTag(notGoodAtInput, setNotGoodAt, setNotGoodAtInput)}
              onRemove={(tag) => removeTag(tag, setNotGoodAt)}
              placeholder={t('skills.notGoodAtPlaceholder')}
            />
          </View>
        ) : (
          <View className="p-4 gap-4">
            {/* Color */}
            <View className="gap-1.5">
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

            {/* Category */}
            <View className="gap-1.5">
              <Label>{t('skills.categoryLabel')}</Label>
              <ToggleGroup
                type="single"
                value={category}
                onValueChange={(val) => setCategory(val as typeof category)}
              >
                {CATEGORIES.map((cat) => (
                  <ToggleGroupItem key={cat} value={cat}>
                    {cat}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </View>

            {/* Tagline */}
            <View className="gap-1.5">
              <Label>{t('skills.taglineLabel')}</Label>
              <Input
                value={tagline}
                onChangeText={setTagline}
                placeholder={t('skills.taglinePlaceholder')}
                placeholderTextColor={colors.mutedForeground}
              />
            </View>

            {/* Description */}
            <View className="gap-1.5">
              <Label>{t('skills.descriptionLabel')}</Label>
              <Textarea
                value={description}
                onChangeText={setDescription}
                placeholder={t('skills.descriptionPlaceholder')}
                placeholderTextColor={colors.mutedForeground}
              />
            </View>

            {/* Use Case */}
            <View className="gap-1.5">
              <Label>{t('skills.useCaseLabel')}</Label>
              <Input
                value={useCase}
                onChangeText={setUseCase}
                placeholder={t('skills.useCasePlaceholder')}
                placeholderTextColor={colors.mutedForeground}
              />
            </View>

            {/* Language badge */}
            <View className="gap-1.5">
              <Label>{t('skills.languageLabel')}</Label>
              <View className="flex-row">
                <View className="bg-muted px-3 py-1.5 rounded-full">
                  <Text className="text-xs font-medium text-muted-foreground uppercase">{language}</Text>
                </View>
              </View>
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );

  return (
    <View className="flex-1 bg-background flex-row">
      {/* Main Content */}
      <View className="flex-1">
        {/* Header */}
        <View className="flex-row items-center justify-between px-4 py-3 border-b border-border">
          <View className="flex-row items-center gap-3">
            <Pressable onPress={() => router.back()} className="active:opacity-70">
              <ArrowLeft size={20} className="text-foreground" />
            </Pressable>
            <Text className="text-sm font-medium text-foreground">
              {t('skills.instructions')}
            </Text>
            <ChevronRight size={14} className="text-muted-foreground" />
            <View className={cn('px-2 py-0.5 rounded-full', isPublished ? 'bg-green-500/15' : 'bg-muted')}>
              <Text className={cn('text-xs font-medium', isPublished ? 'text-green-500' : 'text-muted-foreground')}>
                {isPublished ? t('skills.published') : t('skills.draft')}
              </Text>
            </View>
            {saving && (
              <Text className="text-xs text-muted-foreground ml-2">
                {t('common.saving')}
              </Text>
            )}
          </View>
          <View className="flex-row items-center gap-2">
            {!isLargeScreen && (
              <Pressable onPress={() => setShowPanel(true)} className="p-2 active:opacity-70">
                <Settings size={18} className="text-foreground" />
              </Pressable>
            )}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger>
                <Pressable className="p-2">
                  <Ellipsis size={18} className="text-foreground" />
                </Pressable>
              </DropdownMenu.Trigger>
              <DropdownMenu.Content>
                <DropdownMenu.Item key="delete" onSelect={handleDelete}>
                  <DropdownMenu.ItemIcon ios={{ name: 'trash' }} />
                  <DropdownMenu.ItemTitle>
                    {t('skills.deleteSkill')}
                  </DropdownMenu.ItemTitle>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Root>
            <Button onPress={handlePublishToggle} className="h-8 px-4 rounded-full">
              <Text className="text-sm font-medium text-primary-foreground">
                {isPublished ? t('skills.unpublish') : t('skills.publish')}
              </Text>
            </Button>
          </View>
        </View>

        {/* Main Editor */}
        <ScrollView
          className="flex-1"
          contentContainerStyle={{ padding: 20, paddingBottom: 60 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Cover + Title */}
          <View className="flex-row items-center gap-3 mb-6">
            <SkillCover seed={title || 'default'} width={48} animated={false} />
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder={t('skills.titlePlaceholder')}
              placeholderTextColor={colors.mutedForeground}
              className="text-foreground"
              style={{
                fontSize: 24,
                fontWeight: '700',
                flex: 1,
                padding: 0,
              }}
            />
          </View>

          {/* System Prompt */}
          <Textarea
            variant="ghost"
            value={systemPrompt}
            onChangeText={setSystemPrompt}
            placeholder={t('skills.systemPromptPlaceholder')}
            placeholderTextColor={colors.mutedForeground}
            style={{ fontSize: 15, lineHeight: 22, minHeight: 300 }}
          />
        </ScrollView>
      </View>

      {/* Right Sidebar — Desktop: inline, Mobile: Panel modal */}
      {isLargeScreen ? (
        <View style={{ width: 320 }} className="border-l border-border bg-background">
          {sidebarContent}
        </View>
      ) : (
        <Panel open={showPanel} onClose={() => setShowPanel(false)} side="right" width={320}>
          {sidebarContent}
        </Panel>
      )}
    </View>
  );
}
