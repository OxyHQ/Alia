import React, { useState, useEffect, useCallback } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { useOxy } from '@oxyhq/services';
import { generateAPIUrl } from '@/lib/generate-api-url';
import {
  PenTool,
  RefreshCw,
  Trash2,
  Edit3,
  MessageSquare,
  Globe,
  Type,
  Smile,
  Hash,
  ChevronRight,
} from 'lucide-react-native';
import { useTranslation } from '@/hooks/useTranslation';
import { cn } from '@/lib/utils';
import { toast } from '@/components/sonner';
import { useColorScheme } from '@/lib/useColorScheme';
import { SettingsHeader } from '@/components/settings/settings-header';

interface WritingStyleProfile {
  messagesAnalyzed: number;
  isReady: boolean;
  lastAnalyzedAt: string;
  lastLLMRefinedAt?: string;
  vocabularyLevel: string;
  commonWords: string[];
  commonPhrases: string[];
  jargonTerms: string[];
  avgSentenceLength: number;
  sentenceComplexity: string;
  avgMessageLength: number;
  formality: string;
  toneDescriptors: string[];
  usesEmoji: boolean;
  emojiFrequency: string;
  commonEmojis: string[];
  usesExclamationMarks: boolean;
  usesEllipsis: boolean;
  capitalizationStyle: string;
  greetingPatterns: string[];
  closingPatterns: string[];
  signOff?: string;
  primaryLanguage: string;
  secondaryLanguages: string[];
  codeSwitch: boolean;
  llmSummary?: string;
}

const STYLE_MIN_MESSAGES = 15;

const FORMALITY_LABELS: Record<string, string> = {
  very_informal: 'Very Informal',
  informal: 'Informal',
  neutral: 'Neutral',
  formal: 'Formal',
  very_formal: 'Very Formal',
};

const FORMALITY_COLORS: Record<string, string> = {
  very_informal: 'bg-orange-500',
  informal: 'bg-yellow-500',
  neutral: 'bg-blue-500',
  formal: 'bg-indigo-500',
  very_formal: 'bg-purple-500',
};

const EMOJI_LABELS: Record<string, string> = {
  never: 'Never',
  rare: 'Rarely',
  moderate: 'Sometimes',
  frequent: 'Frequently',
};

const LANG_LABELS: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  pt: 'Portuguese',
  de: 'German',
};

function StatCard({ icon: Icon, label, value, color }: { icon: any; label: string; value: string; color?: string }) {
  return (
    <View className="flex-1 min-w-[140px] bg-muted/50 rounded-xl p-3 gap-1.5">
      <View className="flex-row items-center gap-1.5">
        <Icon size={14} className="text-muted-foreground" />
        <Text className="text-[11px] text-muted-foreground font-medium">{label}</Text>
      </View>
      <Text className={cn('text-sm font-semibold', color || 'text-foreground')}>{value}</Text>
    </View>
  );
}

function TagList({ items, emptyText }: { items: string[]; emptyText?: string }) {
  if (items.length === 0) {
    return <Text className="text-xs text-muted-foreground italic">{emptyText || 'None detected'}</Text>;
  }
  return (
    <View className="flex-row flex-wrap gap-1.5">
      {items.map((item, i) => (
        <View key={i} className="bg-primary/10 rounded-full px-2.5 py-1">
          <Text className="text-xs text-primary font-medium">{item}</Text>
        </View>
      ))}
    </View>
  );
}

function ProgressBar({ current, total }: { current: number; total: number }) {
  const pct = Math.min(100, Math.round((current / total) * 100));
  return (
    <View className="gap-1.5">
      <View className="flex-row justify-between">
        <Text className="text-xs text-muted-foreground">{current} / {total} messages</Text>
        <Text className="text-xs text-muted-foreground">{pct}%</Text>
      </View>
      <View className="h-2 bg-muted rounded-full overflow-hidden">
        <View className="h-full bg-primary rounded-full" style={{ width: `${pct}%` }} />
      </View>
    </View>
  );
}

export default function WritingStyleScreen() {
  const { isAuthenticated, oxyServices } = useOxy();
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const [profile, setProfile] = useState<WritingStyleProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);

  // Edit form state
  const [editSignOff, setEditSignOff] = useState('');
  const [editGreetings, setEditGreetings] = useState('');
  const [editClosings, setEditClosings] = useState('');
  const [editToneDescriptors, setEditToneDescriptors] = useState('');
  const [saving, setSaving] = useState(false);

  const getHeaders = useCallback(() => {
    const token = oxyServices.getAccessToken();
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    };
  }, [oxyServices]);

  const fetchProfile = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      setLoading(true);
      const res = await fetch(generateAPIUrl('/writing-style'), { headers: getHeaders() });
      if (res.ok) {
        const data = await res.json();
        setProfile(data.writingStyle || null);
      }
    } catch (error) {
      console.error('Failed to fetch writing style:', error);
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, getHeaders]);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const res = await fetch(generateAPIUrl('/writing-style/refresh'), {
        method: 'POST',
        headers: getHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        setProfile(data.writingStyle || null);
        toast.success('Style profile refreshed');
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to refresh');
      }
    } catch {
      toast.error('Failed to refresh style profile');
    } finally {
      setRefreshing(false);
    }
  };

  const handleReset = async () => {
    try {
      const res = await fetch(generateAPIUrl('/writing-style'), {
        method: 'DELETE',
        headers: getHeaders(),
      });
      if (res.ok) {
        setProfile(null);
        toast.success('Style profile reset');
      }
    } catch {
      toast.error('Failed to reset style profile');
    }
    setShowResetDialog(false);
  };

  const openEditDialog = () => {
    if (!profile) return;
    setEditSignOff(profile.signOff || '');
    setEditGreetings(profile.greetingPatterns.join(', '));
    setEditClosings(profile.closingPatterns.join(', '));
    setEditToneDescriptors(profile.toneDescriptors.join(', '));
    setShowEditDialog(true);
  };

  const handleSaveEdits = async () => {
    setSaving(true);
    try {
      const body = {
        signOff: editSignOff.trim() || undefined,
        greetingPatterns: editGreetings.split(',').map(s => s.trim()).filter(Boolean),
        closingPatterns: editClosings.split(',').map(s => s.trim()).filter(Boolean),
        toneDescriptors: editToneDescriptors.split(',').map(s => s.trim()).filter(Boolean),
      };
      const res = await fetch(generateAPIUrl('/writing-style'), {
        method: 'PUT',
        headers: getHeaders(),
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        setProfile(data.writingStyle || null);
        toast.success('Style profile updated');
        setShowEditDialog(false);
      } else {
        toast.error('Failed to save changes');
      }
    } catch {
      toast.error('Failed to save changes');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title={t('settings.sections.writingStyle') || 'Writing Style'} />
      <ScrollView className="flex-1" contentContainerClassName="p-5 max-w-2xl gap-5">
        {/* Header */}
        <View className="gap-1">
          <View className="flex-row items-center gap-2">
            <PenTool size={20} className="text-primary" />
            <Text className="text-base font-bold">Writing Style Profile</Text>
          </View>
          <Text className="text-sm text-muted-foreground">
            Alia learns how you write so it can compose emails and messages in your voice.
          </Text>
        </View>

        {loading ? (
          <View className="items-center justify-center py-12">
            <Text className="text-muted-foreground">Loading...</Text>
          </View>
        ) : !profile ? (
          /* No profile yet */
          <View className="bg-muted/50 rounded-2xl p-6 items-center gap-3">
            <PenTool size={32} className="text-muted-foreground" />
            <Text className="text-sm font-semibold text-center">No style profile yet</Text>
            <Text className="text-xs text-muted-foreground text-center max-w-[280px]">
              Keep chatting with Alia. After {STYLE_MIN_MESSAGES} messages, your writing style profile will start building automatically.
            </Text>
          </View>
        ) : (
          <>
            {/* Progress / Status */}
            {!profile.isReady ? (
              <View className="bg-muted/50 rounded-2xl p-4 gap-3">
                <View className="flex-row items-center gap-2">
                  <Hash size={16} className="text-primary" />
                  <Text className="text-sm font-semibold">Building profile...</Text>
                </View>
                <ProgressBar current={profile.messagesAnalyzed} total={STYLE_MIN_MESSAGES} />
                <Text className="text-xs text-muted-foreground">
                  Keep chatting! The profile activates after {STYLE_MIN_MESSAGES} messages.
                </Text>
              </View>
            ) : (
              <View className="bg-primary/5 rounded-2xl p-4 flex-row items-center gap-3">
                <View className="w-2 h-2 rounded-full bg-green-500" />
                <Text className="text-sm font-medium flex-1">Profile active — {profile.messagesAnalyzed} messages analyzed</Text>
              </View>
            )}

            {/* LLM Summary */}
            {profile.llmSummary && (
              <View className="bg-muted/50 rounded-2xl p-4 gap-2">
                <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">AI Summary</Text>
                <Text className="text-sm text-foreground leading-5">"{profile.llmSummary}"</Text>
              </View>
            )}

            {/* Stats Grid */}
            <View className="gap-2">
              <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Overview</Text>
              <View className="flex-row flex-wrap gap-2">
                <StatCard
                  icon={MessageSquare}
                  label="Formality"
                  value={FORMALITY_LABELS[profile.formality] || profile.formality}
                />
                <StatCard
                  icon={Type}
                  label="Vocabulary"
                  value={profile.vocabularyLevel.charAt(0).toUpperCase() + profile.vocabularyLevel.slice(1)}
                />
              </View>
              <View className="flex-row flex-wrap gap-2">
                <StatCard
                  icon={Type}
                  label="Avg. Sentence"
                  value={`~${Math.round(profile.avgSentenceLength)} words`}
                />
                <StatCard
                  icon={Smile}
                  label="Emoji"
                  value={EMOJI_LABELS[profile.emojiFrequency] || profile.emojiFrequency}
                />
              </View>
              <View className="flex-row flex-wrap gap-2">
                <StatCard
                  icon={Globe}
                  label="Language"
                  value={LANG_LABELS[profile.primaryLanguage] || profile.primaryLanguage}
                />
                <StatCard
                  icon={Type}
                  label="Capitalization"
                  value={profile.capitalizationStyle === 'all_lowercase' ? 'Lowercase' : profile.capitalizationStyle === 'mixed' ? 'Mixed' : 'Standard'}
                />
              </View>
            </View>

            {/* Formality Scale */}
            <View className="gap-2">
              <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Formality Scale</Text>
              <View className="flex-row h-3 rounded-full overflow-hidden">
                {(['very_informal', 'informal', 'neutral', 'formal', 'very_formal'] as const).map(level => (
                  <View
                    key={level}
                    className={cn(
                      'flex-1',
                      profile.formality === level
                        ? FORMALITY_COLORS[level]
                        : 'bg-muted',
                    )}
                  />
                ))}
              </View>
              <View className="flex-row justify-between">
                <Text className="text-[10px] text-muted-foreground">Casual</Text>
                <Text className="text-[10px] text-muted-foreground">Formal</Text>
              </View>
            </View>

            {/* Tone Descriptors */}
            <View className="gap-2">
              <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Tone</Text>
              <TagList items={profile.toneDescriptors} emptyText="Will be detected after AI analysis" />
            </View>

            {/* Greetings */}
            <View className="gap-2">
              <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Greeting Patterns</Text>
              <TagList items={profile.greetingPatterns} emptyText="No greeting patterns detected yet" />
            </View>

            {/* Closings */}
            <View className="gap-2">
              <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Closing Patterns</Text>
              <TagList items={profile.closingPatterns} emptyText="No closing patterns detected yet" />
              {profile.signOff && (
                <Text className="text-xs text-muted-foreground">Preferred sign-off: <Text className="font-medium text-foreground">{profile.signOff}</Text></Text>
              )}
            </View>

            {/* Common Words */}
            {profile.commonWords.length > 0 && (
              <View className="gap-2">
                <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Characteristic Words</Text>
                <TagList items={profile.commonWords.slice(0, 12)} />
              </View>
            )}

            {/* Jargon */}
            {profile.jargonTerms && profile.jargonTerms.length > 0 && (
              <View className="gap-2">
                <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Domain Terms</Text>
                <TagList items={profile.jargonTerms} />
              </View>
            )}

            {/* Secondary Languages */}
            {profile.secondaryLanguages.length > 0 && (
              <View className="gap-2">
                <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Other Languages</Text>
                <TagList items={profile.secondaryLanguages.map(l => LANG_LABELS[l] || l)} />
                {profile.codeSwitch && (
                  <Text className="text-xs text-muted-foreground">You sometimes mix languages in messages</Text>
                )}
              </View>
            )}

            {/* Actions */}
            <View className="gap-2 pt-2">
              <Button
                onPress={openEditDialog}
                variant="outline"
                className="flex-row items-center gap-2 h-10"
              >
                <Edit3 size={15} className="text-foreground" />
                <Text className="text-sm font-medium">Edit Preferences</Text>
              </Button>
              <View className="flex-row gap-2">
                <Button
                  onPress={handleRefresh}
                  variant="outline"
                  disabled={refreshing || profile.messagesAnalyzed < 50}
                  className="flex-1 flex-row items-center gap-2 h-10"
                >
                  <RefreshCw size={15} className={refreshing ? 'text-muted-foreground animate-spin' : 'text-foreground'} />
                  <Text className="text-sm font-medium">{refreshing ? 'Refreshing...' : 'AI Refresh'}</Text>
                </Button>
                <Button
                  onPress={() => setShowResetDialog(true)}
                  variant="outline"
                  className="flex-row items-center gap-2 h-10 border-destructive/30"
                >
                  <Trash2 size={15} className="text-destructive" />
                  <Text className="text-sm font-medium text-destructive">Reset</Text>
                </Button>
              </View>
              {profile.messagesAnalyzed < 50 && (
                <Text className="text-[11px] text-muted-foreground text-center">
                  AI Refresh available after 50 messages ({profile.messagesAnalyzed} so far)
                </Text>
              )}
            </View>
          </>
        )}
      </ScrollView>

      {/* Edit Dialog */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Style Preferences</DialogTitle>
            <DialogDescription>
              Customize how Alia writes on your behalf.
            </DialogDescription>
          </DialogHeader>
          <View className="gap-4 py-2">
            <View className="gap-1.5">
              <Text className="text-sm font-medium">Sign-off</Text>
              <Input
                value={editSignOff}
                onChangeText={setEditSignOff}
                placeholder="e.g., Best regards, Cheers"
              />
            </View>
            <View className="gap-1.5">
              <Text className="text-sm font-medium">Greeting Patterns</Text>
              <Input
                value={editGreetings}
                onChangeText={setEditGreetings}
                placeholder="e.g., Hey, Hi there, Hello"
              />
              <Text className="text-[11px] text-muted-foreground">Comma-separated</Text>
            </View>
            <View className="gap-1.5">
              <Text className="text-sm font-medium">Closing Patterns</Text>
              <Input
                value={editClosings}
                onChangeText={setEditClosings}
                placeholder="e.g., Thanks, Best, Cheers"
              />
              <Text className="text-[11px] text-muted-foreground">Comma-separated</Text>
            </View>
            <View className="gap-1.5">
              <Text className="text-sm font-medium">Tone Descriptors</Text>
              <Input
                value={editToneDescriptors}
                onChangeText={setEditToneDescriptors}
                placeholder="e.g., friendly, direct, professional"
              />
              <Text className="text-[11px] text-muted-foreground">Comma-separated</Text>
            </View>
          </View>
          <DialogFooter>
            <Button variant="outline" onPress={() => setShowEditDialog(false)}>
              <Text>Cancel</Text>
            </Button>
            <Button onPress={handleSaveEdits} disabled={saving}>
              <Text className="text-primary-foreground">{saving ? 'Saving...' : 'Save'}</Text>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset Confirmation */}
      <ConfirmationDialog
        open={showResetDialog}
        onOpenChange={setShowResetDialog}
        title="Reset Writing Style"
        description="This will delete your writing style profile. Alia will start learning again from scratch."
        confirmLabel="Reset"
        variant="destructive"
        onConfirm={handleReset}
      />
    </View>
  );
}
