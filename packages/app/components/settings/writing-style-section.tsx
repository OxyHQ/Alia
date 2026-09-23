import { errorBodyText } from '@/lib/errors/error-utils';
import { generateAPIUrl } from '@/lib/generate-api-url';
import { useTranslation } from '@/lib/hooks/use-translation';
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiEditLine } from '@oxy.so/bloom/icons/RiEditLine';
import { RiRefreshLine } from '@oxy.so/bloom/icons/RiRefreshLine';
import {
  SettingsGeneralPage,
  SettingsSection,
  SettingsValueField,
} from '@oxy.so/bloom/settings-modal';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { confirm } from '@oxy.so/bloom/surfaces';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
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
/** The server refines the profile with AI only past this many messages. */
const AI_ANALYSIS_MIN_MESSAGES = 50;

const K = 'settings.assistant.writingStyle';

/** The enum values with a translated label; anything else shows raw. */
const KNOWN = {
  formality: [
    'very_informal',
    'informal',
    'neutral',
    'formal',
    'very_formal',
  ],
  emoji: ['never', 'rare', 'moderate', 'frequent'],
  language: ['en', 'es', 'fr', 'pt', 'de'],
} as const;

function enumLabel(
  t: (key: string) => string,
  group: keyof typeof KNOWN,
  value: string,
): string {
  return (KNOWN[group] as readonly string[]).includes(value)
    ? t(`${K}.${group}.${value}`)
    : value;
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function WritingStyleSection() {
  const { isAuthenticated, oxyServices } = useOxy();
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
        toast.success(t(`${K}.refreshed`));
      } else {
        const data = await res.json();
        toast.error(errorBodyText(data, t(`${K}.refreshFailed`)));
      }
    } catch {
      toast.error(t(`${K}.refreshFailedLong`));
    } finally {
      setRefreshing(false);
    }
  };

  const handleReset = async () => {
    const ok = await confirm({
      title: t(`${K}.resetTitle`),
      description: t(`${K}.resetDescription`),
      confirmLabel: t(`${K}.reset`),
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
        toast.success(t(`${K}.resetDone`));
      }
    } catch {
      toast.error(t(`${K}.resetFailed`));
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
        greetingPatterns: splitList(editGreetings),
        closingPatterns: splitList(editClosings),
        toneDescriptors: splitList(editToneDescriptors),
      };
      const res = await fetch(generateAPIUrl('/writing-style'), {
        method: 'PUT',
        headers: getHeaders(),
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        setProfile(data.writingStyle || null);
        toast.success(t(`${K}.updated`));
        setShowEditDialog(false);
      } else {
        toast.error(t(`${K}.saveFailed`));
      }
    } catch {
      toast.error(t(`${K}.saveFailed`));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    // The page's own geometry, shimmering: the status card, then the overview.
    return (
      <Skeleton.Col style={{ gap: 24 }}>
        <Skeleton.Box width="100%" height={52} borderRadius={16} />
        <Skeleton.Box width="100%" height={312} borderRadius={16} />
      </Skeleton.Col>
    );
  }

  if (!profile) {
    return (
      <SettingsGeneralPage
        sections={[
          {
            key: 'empty',
            rows: [
              {
                key: 'empty',
                label: t(`${K}.emptyTitle`),
                description: t(`${K}.emptyDescription`, {
                  min: STYLE_MIN_MESSAGES,
                }),
              },
            ],
          },
        ]}
      />
    );
  }

  const notDetected = t(`${K}.notDetected`);
  const valueRow = (key: string, label: string, value: string) => ({
    key,
    label,
    control: <SettingsValueField>{value}</SettingsValueField>,
  });
  const aiLocked = profile.messagesAnalyzed < AI_ANALYSIS_MIN_MESSAGES;

  return (
    <>
      <SettingsGeneralPage
        sections={[
          {
            key: 'status',
            rows: [
              valueRow(
                'status',
                profile.isReady
                  ? t(`${K}.statusActive`)
                  : t(`${K}.statusBuilding`),
                t(`${K}.messagesAnalyzed`, { n: profile.messagesAnalyzed }),
              ),
              ...(profile.llmSummary
                ? [
                    {
                      key: 'summary',
                      label: t(`${K}.aiSummary`),
                      description: profile.llmSummary,
                    },
                  ]
                : []),
            ],
          },
          {
            key: 'overview',
            label: t(`${K}.overview`),
            rows: [
              valueRow(
                'formality',
                t(`${K}.formalityLabel`),
                enumLabel(t, 'formality', profile.formality),
              ),
              valueRow(
                'vocabulary',
                t(`${K}.vocabulary`),
                profile.vocabularyLevel,
              ),
              valueRow(
                'sentence',
                t(`${K}.avgSentence`),
                t(`${K}.avgSentenceValue`, {
                  n: Math.round(profile.avgSentenceLength),
                }),
              ),
              valueRow(
                'emoji',
                t(`${K}.emojiLabel`),
                enumLabel(t, 'emoji', profile.emojiFrequency),
              ),
              valueRow(
                'language',
                t(`${K}.languageLabel`),
                enumLabel(t, 'language', profile.primaryLanguage),
              ),
              valueRow(
                'capitalization',
                t(`${K}.capitalization`),
                profile.capitalizationStyle,
              ),
            ],
          },
          {
            key: 'patterns',
            label: t(`${K}.patterns`),
            rows: [
              {
                key: 'tone',
                label: t(`${K}.tone`),
                description: profile.toneDescriptors.join(', ') || notDetected,
              },
              {
                key: 'greetings',
                label: t(`${K}.greetings`),
                description: profile.greetingPatterns.join(', ') || notDetected,
              },
              {
                key: 'closings',
                label: t(`${K}.closings`),
                description: profile.closingPatterns.join(', ') || notDetected,
              },
              {
                key: 'signoff',
                label: t(`${K}.signOff`),
                description: profile.signOff || notDetected,
              },
              {
                key: 'words',
                label: t(`${K}.words`),
                description: profile.commonWords.join(', ') || notDetected,
              },
              {
                key: 'jargon',
                label: t(`${K}.jargon`),
                description: profile.jargonTerms?.join(', ') || notDetected,
              },
              {
                key: 'languages',
                label: t(`${K}.otherLanguages`),
                description:
                  profile.secondaryLanguages
                    .map((l) => enumLabel(t, 'language', l))
                    .join(', ') || t(`${K}.noneDetected`),
              },
              ...(profile.codeSwitch
                ? [
                    {
                      key: 'switch',
                      label: t(`${K}.multilingual`),
                      description: t(`${K}.multilingualDescription`),
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
                label: t(`${K}.preferences`),
                description: t(`${K}.editDescription`),
                control: (
                  <Button
                    size="sm"
                    appearance="outline"
                    tone="neutral"
                    leadingIcon={RiEditLine}
                    onPress={openEditDialog}
                  >
                    {t('common.edit')}
                  </Button>
                ),
              },
              {
                key: 'refresh',
                label: t(`${K}.aiAnalysis`),
                description: aiLocked
                  ? t(`${K}.aiAnalysisLocked`, {
                      min: AI_ANALYSIS_MIN_MESSAGES,
                      n: profile.messagesAnalyzed,
                    })
                  : undefined,
                control: (
                  <Button
                    size="sm"
                    appearance="outline"
                    tone="neutral"
                    leadingIcon={RiRefreshLine}
                    onPress={handleRefresh}
                    disabled={refreshing || aiLocked}
                  >
                    {refreshing ? t(`${K}.refreshing`) : t(`${K}.refresh`)}
                  </Button>
                ),
              },
              {
                key: 'reset',
                label: t(`${K}.resetProfile`),
                description: t(`${K}.resetDescription`),
                control: (
                  <Button
                    size="sm"
                    appearance="outline"
                    tone="neutral"
                    leadingIcon={RiDeleteBinLine}
                    onPress={handleReset}
                  >
                    {t(`${K}.reset`)}
                  </Button>
                ),
              },
            ],
          },
        ]}
      />
      <Dialog
        open={showEditDialog}
        onClose={() => setShowEditDialog(false)}
        placement={{ base: 'bottom', md: 'center' }}
        title={t(`${K}.editTitle`)}
        description={t(`${K}.editDescription`)}
        actions={[
          { label: t('common.cancel'), color: 'cancel' },
          {
            label: saving ? t('common.saving') : t('common.save'),
            onPress: handleSaveEdits,
            disabled: saving,
            // The save is in flight when this runs and the label reports it.
            shouldCloseOnPress: false,
          },
        ]}
      >
        <View style={FORM}>
          <SettingsSection label={t(`${K}.signOff`)}>
            <TextFieldInput
              label={t(`${K}.signOff`)}
              placeholder={t(`${K}.signOffPlaceholder`)}
              value={editSignOff}
              onValueChange={setEditSignOff}
            />
          </SettingsSection>
          <SettingsSection
            label={t(`${K}.greetingPatterns`)}
            description={t(`${K}.commaSeparated`)}
          >
            <TextFieldInput
              label={t(`${K}.greetingPatterns`)}
              placeholder={t(`${K}.greetingPlaceholder`)}
              value={editGreetings}
              onValueChange={setEditGreetings}
            />
          </SettingsSection>
          <SettingsSection
            label={t(`${K}.closingPatterns`)}
            description={t(`${K}.commaSeparated`)}
          >
            <TextFieldInput
              label={t(`${K}.closingPatterns`)}
              placeholder={t(`${K}.closingPlaceholder`)}
              value={editClosings}
              onValueChange={setEditClosings}
            />
          </SettingsSection>
          <SettingsSection
            label={t(`${K}.toneDescriptors`)}
            description={t(`${K}.commaSeparated`)}
          >
            <TextFieldInput
              label={t(`${K}.toneDescriptors`)}
              placeholder={t(`${K}.tonePlaceholder`)}
              value={editToneDescriptors}
              onValueChange={setEditToneDescriptors}
            />
          </SettingsSection>
        </View>
      </Dialog>
    </>
  );
}

/** The dialog's labelled fields, stacked like the page's sections. */
const FORM = { gap: 16 } as const;
