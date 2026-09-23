import { errorBodyText } from '@/lib/errors/error-utils';
import { generateAPIUrl } from '@/lib/generate-api-url';
import { useTranslation } from '@/lib/hooks/use-translation';
import { useColorScheme } from '@/lib/useColorScheme';
import { cn } from '@/lib/utils';
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import {
  SettingsGeneralPage,
  SettingsValueField,
} from '@oxy.so/bloom/settings-modal';
import { confirm } from '@oxy.so/bloom/surfaces';
import { TextFieldInput as Input } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { useOxy } from '@oxy.so/services';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';

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

function StatCard({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: any;
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <View className="flex-1 min-w-[140px] bg-muted/50 rounded-xl p-3 gap-1.5">
      <View className="flex-row items-center gap-1.5">
        <Icon size={14} className="text-muted-foreground" />
        <Text className="text-[11px] text-muted-foreground font-medium">
          {label}
        </Text>
      </View>
      <Text className={cn('text-sm font-semibold', color || 'text-foreground')}>
        {value}
      </Text>
    </View>
  );
}

function TagList({
  items,
  emptyText,
}: {
  items: string[];
  emptyText?: string;
}) {
  if (items.length === 0) {
    return (
      <Text className="text-xs text-muted-foreground italic">
        {emptyText || 'None detected'}
      </Text>
    );
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
        <Text className="text-xs text-muted-foreground">
          {current} / {total} messages
        </Text>
        <Text className="text-xs text-muted-foreground">{pct}%</Text>
      </View>
      <View className="h-2 bg-muted rounded-full overflow-hidden">
        <View
          className="h-full bg-primary rounded-full"
          style={{ width: `${pct}%` }}
        />
      </View>
    </View>
  );
}

export function WritingStyleSection() {
  const { isAuthenticated, oxyServices } = useOxy();
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const [profile, setProfile] = useState<WritingStyleProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
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
      Authorization: `Bearer ${token}`,
    };
  }, [oxyServices]);

  const fetchProfile = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      setLoading(true);
      const res = await fetch(generateAPIUrl('/writing-style'), {
        headers: getHeaders(),
      });
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
        toast.error(errorBodyText(data, 'Failed to refresh'));
      }
    } catch {
      toast.error('Failed to refresh style profile');
    } finally {
      setRefreshing(false);
    }
  };

  const handleReset = async () => {
    const ok = await confirm({
      title: 'Reset Writing Style',
      description:
        'This will delete your writing style profile. Alia will start learning again from scratch.',
      confirmLabel: 'Reset',
      destructive: true,
    });
    if (!ok) return;
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
        greetingPatterns: editGreetings
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        closingPatterns: editClosings
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        toneDescriptors: editToneDescriptors
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
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
    <View className="gap-4">
      <SettingsGeneralPage
        sections={
          loading
            ? [
                {
                  key: 'loading',
                  rows: [{ key: 'loading', label: 'Loading…' }],
                },
              ]
            : !profile
              ? [
                  {
                    key: 'empty',
                    rows: [
                      {
                        key: 'empty',
                        label: 'No style profile yet',
                        description: `After ${STYLE_MIN_MESSAGES} messages, your writing style profile will start building automatically.`,
                      },
                    ],
                  },
                ]
              : [
                  {
                    key: 'status',
                    rows: [
                      {
                        key: 'status',
                        label: profile.isReady
                          ? 'Profile active'
                          : 'Building profile',
                        control: (
                          <SettingsValueField>
                            {profile.messagesAnalyzed} messages analyzed
                          </SettingsValueField>
                        ),
                      },
                      ...(profile.llmSummary
                        ? [
                            {
                              key: 'summary',
                              label: 'AI summary',
                              description: profile.llmSummary,
                            },
                          ]
                        : []),
                    ],
                  },
                  {
                    key: 'overview',
                    label: 'Overview',
                    rows: [
                      {
                        key: 'formality',
                        label: 'Formality',
                        control: (
                          <SettingsValueField>
                            {FORMALITY_LABELS[profile.formality] ||
                              profile.formality}
                          </SettingsValueField>
                        ),
                      },
                      {
                        key: 'vocabulary',
                        label: 'Vocabulary',
                        control: (
                          <SettingsValueField>
                            {profile.vocabularyLevel}
                          </SettingsValueField>
                        ),
                      },
                      {
                        key: 'sentence',
                        label: 'Average sentence',
                        control: (
                          <SettingsValueField>
                            ~{Math.round(profile.avgSentenceLength)} words
                          </SettingsValueField>
                        ),
                      },
                      {
                        key: 'emoji',
                        label: 'Emoji',
                        control: (
                          <SettingsValueField>
                            {EMOJI_LABELS[profile.emojiFrequency] ||
                              profile.emojiFrequency}
                          </SettingsValueField>
                        ),
                      },
                      {
                        key: 'language',
                        label: 'Language',
                        control: (
                          <SettingsValueField>
                            {LANG_LABELS[profile.primaryLanguage] ||
                              profile.primaryLanguage}
                          </SettingsValueField>
                        ),
                      },
                      {
                        key: 'capitalization',
                        label: 'Capitalization',
                        control: (
                          <SettingsValueField>
                            {profile.capitalizationStyle}
                          </SettingsValueField>
                        ),
                      },
                    ],
                  },
                  {
                    key: 'patterns',
                    label: 'Patterns',
                    rows: [
                      {
                        key: 'tone',
                        label: 'Tone',
                        description:
                          profile.toneDescriptors.join(', ') ||
                          'Not detected yet',
                      },
                      {
                        key: 'greetings',
                        label: 'Greetings',
                        description:
                          profile.greetingPatterns.join(', ') ||
                          'Not detected yet',
                      },
                      {
                        key: 'closings',
                        label: 'Closings',
                        description:
                          profile.closingPatterns.join(', ') ||
                          'Not detected yet',
                      },
                      {
                        key: 'signoff',
                        label: 'Sign-off',
                        description: profile.signOff || 'Not detected yet',
                      },
                      {
                        key: 'words',
                        label: 'Characteristic words',
                        description:
                          profile.commonWords.join(', ') || 'Not detected yet',
                      },
                      {
                        key: 'jargon',
                        label: 'Domain terms',
                        description:
                          profile.jargonTerms?.join(', ') || 'Not detected yet',
                      },
                      {
                        key: 'languages',
                        label: 'Other languages',
                        description:
                          profile.secondaryLanguages
                            .map((l) => LANG_LABELS[l] || l)
                            .join(', ') || 'None detected',
                      },
                      ...(profile.codeSwitch
                        ? [
                            {
                              key: 'switch',
                              label: 'Multilingual messages',
                              description:
                                'You sometimes mix languages in messages',
                            },
                          ]
                        : []),
                    ],
                  },
                  {
                    key: 'actions',
                    rows: [
                      {
                        key: 'edit',
                        label: 'Preferences',
                        control: (
                          <Button
                            variant="secondary"
                            size="sm"
                            onPress={openEditDialog}
                          >
                            Edit
                          </Button>
                        ),
                      },
                      {
                        key: 'refresh',
                        label: 'AI analysis',
                        description:
                          profile.messagesAnalyzed < 50
                            ? `Available after 50 messages (${profile.messagesAnalyzed} so far)`
                            : undefined,
                        control: (
                          <Button
                            variant="secondary"
                            size="sm"
                            onPress={handleRefresh}
                            disabled={
                              refreshing || profile.messagesAnalyzed < 50
                            }
                          >
                            {refreshing ? 'Refreshing…' : 'Refresh'}
                          </Button>
                        ),
                      },
                      {
                        key: 'reset',
                        label: 'Reset profile',
                        control: (
                          <Button
                            variant="secondary"
                            tone="danger"
                            size="sm"
                            onPress={handleReset}
                          >
                            Reset
                          </Button>
                        ),
                      },
                    ],
                  },
                ]
        }
      />
      {/* Edit Dialog */}
      <Dialog
        open={showEditDialog}
        onClose={() => setShowEditDialog(false)}
        placement={{ base: 'bottom', md: 'center' }}
        title="Edit Style Preferences"
        description="Customize how Alia writes on your behalf."
        actions={[
          { label: 'Cancel', color: 'cancel' },
          {
            label: saving ? 'Saving...' : 'Save',
            onPress: handleSaveEdits,
            disabled: saving,
            // The save is in flight when this runs and the label reports it.
            shouldCloseOnPress: false,
          },
        ]}
      >
        <View className="gap-4 py-2">
          <View className="gap-1.5">
            <Text className="text-sm font-medium">Sign-off</Text>
            <Input
              label="e.g., Best regards, Cheers"
              value={editSignOff}
              onChangeText={setEditSignOff}
              placeholder="e.g., Best regards, Cheers"
            />
          </View>
          <View className="gap-1.5">
            <Text className="text-sm font-medium">Greeting Patterns</Text>
            <Input
              label="e.g., Hey, Hi there, Hello"
              value={editGreetings}
              onChangeText={setEditGreetings}
              placeholder="e.g., Hey, Hi there, Hello"
            />
            <Text className="text-[11px] text-muted-foreground">
              Comma-separated
            </Text>
          </View>
          <View className="gap-1.5">
            <Text className="text-sm font-medium">Closing Patterns</Text>
            <Input
              label="e.g., Thanks, Best, Cheers"
              value={editClosings}
              onChangeText={setEditClosings}
              placeholder="e.g., Thanks, Best, Cheers"
            />
            <Text className="text-[11px] text-muted-foreground">
              Comma-separated
            </Text>
          </View>
          <View className="gap-1.5">
            <Text className="text-sm font-medium">Tone Descriptors</Text>
            <Input
              label="e.g., friendly, direct, professional"
              value={editToneDescriptors}
              onChangeText={setEditToneDescriptors}
              placeholder="e.g., friendly, direct, professional"
            />
            <Text className="text-[11px] text-muted-foreground">
              Comma-separated
            </Text>
          </View>
        </View>
      </Dialog>
    </View>
  );
}
