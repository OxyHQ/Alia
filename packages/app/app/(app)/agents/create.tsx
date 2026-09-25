import { Composer } from '@/components/chat/composer/composer';
import { useAliaComposer } from '@/components/chat/composer/use-alia-composer';
import { errorMessage as getErrorMessage } from '@/lib/errors/error-utils';
import { useGenerateAgent } from '@/lib/hooks/agents/use-generate-agent';
import { useTranslation } from '@/lib/hooks/use-translation';
import type { BloomIconComponent } from '@oxy.so/bloom/icons';
import { RiBarChartHorizontalLine } from '@oxy.so/bloom/icons/RiBarChartHorizontalLine';
import { RiCheckLine } from '@oxy.so/bloom/icons/RiCheckLine';
import { RiQuestionLine } from '@oxy.so/bloom/icons/RiQuestionLine';
import { RiRouteLine } from '@oxy.so/bloom/icons/RiRouteLine';
import { RiSparklingLine } from '@oxy.so/bloom/icons/RiSparklingLine';
import { Item } from '@oxy.so/bloom/item';
import { Loading } from '@oxy.so/bloom/loading';
import { toast } from '@oxy.so/bloom/toast';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, View } from 'react-native';
type Archetype = 'general' | 'qa' | 'task_router' | 'status_update';

interface ArchetypeOption {
  value: Archetype;
  label: string;
  description: string;
  Icon: BloomIconComponent;
}

const ARCHETYPE_OPTIONS: ArchetypeOption[] = [
  {
    value: 'general',
    label: 'General',
    description: 'Build any custom agent',
    Icon: RiSparklingLine,
  },
  {
    value: 'qa',
    label: 'Q&A',
    description: 'Answers questions from your knowledge',
    Icon: RiQuestionLine,
  },
  {
    value: 'task_router',
    label: 'Task Router',
    description: 'Triages and routes incoming tasks',
    Icon: RiRouteLine,
  },
  {
    value: 'status_update',
    label: 'Status Update',
    description: 'Generates scheduled reports',
    Icon: RiBarChartHorizontalLine,
  },
];

export default function CreateAgentScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const generateAgent = useGenerateAgent();

  const [inputValue, setInputValue] = useState("");
  const [generating, setGenerating] = useState(false);
  const composer = useAliaComposer({
    draft: 'surface:agent-create',
    locked: generating,
    // `/agents/generate` reads the prompt and nothing else — no model, effort, mode,
    // file, skill or connector — so the composer offers none of them.
    promptOnly: true,
  });
  const [selectedArchetype, setSelectedArchetype] = useState<Archetype>('general');

  const handleGenerate = useCallback(async () => {
    if (!inputValue.trim() || generating) return;
    setGenerating(true);

    try {
      const { agent, adjustedHandle } = await generateAgent(
        inputValue.trim(),
        selectedArchetype,
      );

      /**
       * Say which handle it got, and only when it is not the one proposed.
       *
       * Informative, never blocking: the account exists either way, and the
       * screen this navigates to is the agent editor, which has a handle
       * field. So the person reads what they were given and is already
       * standing where they can change it.
       */
      if (adjustedHandle !== null) {
        toast.info(t("agents.handleAdjusted", { handle: adjustedHandle }));
      } else {
        toast.success(t("agents.agentUpdated"));
      }
      router.replace({ pathname: "/(app)/agents/edit/[id]", params: { id: agent._id } });
      // No `else` for a null agent any more: the mutation THROWS a refusal
      // rather than returning null, so a failed create lands in the catch below
      // with the server's own message instead of a swallowed "Failed to create".
    } catch (error: unknown) {
      const message =
        getErrorMessage(error, "Failed to generate agent");
      toast.error(message);
    } finally {
      setGenerating(false);
    }
  }, [inputValue, generating, generateAgent, router, t, selectedArchetype]);

  if (generating) {
    return (
      <View className="flex-1 items-center justify-center">
        <Loading variant="spinner" size="lg" text={t("agents.generating")} />
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerClassName="grow items-center justify-center px-4 py-10"
      keyboardShouldPersistTaps="handled"
    >
      <View className="w-full max-w-[672px] gap-6">
        <Text className="text-center text-lg font-semibold leading-[26px] text-foreground">
          {t("agents.createTitle")}
        </Text>

        {/* Archetype picker: one radio row per archetype. */}
        <View className="gap-2">
          <Muted>{t("pages.agents.agentType")}</Muted>
          <View accessibilityRole="radiogroup" accessibilityLabel={t("pages.agents.agentType")}>
            {ARCHETYPE_OPTIONS.map((option) => (
              <Item
                key={option.value}
                role="radio"
                selected={selectedArchetype === option.value}
                onPress={() => setSelectedArchetype(option.value)}
                leading={<option.Icon width={20} height={20} />}
                trailing={
                  selectedArchetype === option.value ? <RiCheckLine size="md" /> : null
                }
                title={option.label}
                subtitle={option.description}
              />
            ))}
          </View>
        </View>

        {/*
          The simple composer: a field and a send control. `promptOnly`
          gives the panel no model picker, modes or add menu, which is how
          Bloom is told to draw none. `busy` and `disabled` carry the
          same flag on purpose: there is no stream to cancel here, so
          generating greys send rather than offering a stop, and with no
          `onStop` Bloom draws no stop control at all.
        */}
        <Composer
          {...composer.props}
          value={inputValue}
          onValueChange={setInputValue}
          onSubmit={handleGenerate}
          busy={generating}
          disabled={generating}
          placeholder={t("agents.createPlaceholder")}
        />
      </View>
    </ScrollView>
  );
}
