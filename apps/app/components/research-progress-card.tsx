import { useState } from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import {
  Search,
  BookOpen,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader2,
} from 'lucide-react-native';
import { useColorScheme } from '@/lib/useColorScheme';

export interface ResearchSource {
  id: number;
  url: string;
  title: string;
}

export interface ResearchProgressData {
  phase: string;
  message: string;
  subQuestions?: string[];
  sourcesFound?: number;
  currentQuery?: string;
  iteration?: number;
  isComplete?: boolean;
  sources?: ResearchSource[];
  totalSearches?: number;
}

interface ResearchProgressCardProps {
  progress: ResearchProgressData;
}

const PHASE_LABELS: Record<string, string> = {
  decomposing: 'Planning research',
  searching: 'Searching the web',
  reading: 'Reading sources',
  synthesizing: 'Synthesizing report',
  follow_up: 'Follow-up research',
  finalizing: 'Polishing report',
  complete: 'Research complete',
};

const PHASE_ORDER = ['decomposing', 'searching', 'synthesizing', 'follow_up', 'finalizing', 'complete'];

export function ResearchProgressCard({ progress }: ResearchProgressCardProps) {
  const { colors } = useColorScheme();
  const [showSources, setShowSources] = useState(false);
  const [showQuestions, setShowQuestions] = useState(true);

  const phaseIndex = PHASE_ORDER.indexOf(progress.phase);
  const isComplete = progress.phase === 'complete' || progress.isComplete;

  return (
    <View className="mx-3 my-2 rounded-xl border border-border bg-card p-4 gap-3">
      {/* Header */}
      <View className="flex-row items-center gap-2">
        <View className="w-8 h-8 rounded-full bg-primary/10 items-center justify-center">
          {isComplete ? (
            <CheckCircle size={16} color="#22c55e" />
          ) : (
            <Search size={16} color={colors.primary} />
          )}
        </View>
        <View className="flex-1">
          <Text className="text-sm font-semibold text-foreground">
            Deep Research
          </Text>
          <Text className="text-xs text-muted-foreground">
            {progress.message}
          </Text>
        </View>
        {progress.sourcesFound !== undefined && (
          <View className="bg-muted rounded-full px-2 py-0.5">
            <Text className="text-[10px] text-muted-foreground">
              {progress.sourcesFound} sources
            </Text>
          </View>
        )}
      </View>

      {/* Phase progress */}
      <View className="flex-row gap-1">
        {PHASE_ORDER.map((phase, i) => (
          <View
            key={phase}
            className="flex-1 h-1 rounded-full"
            style={{
              backgroundColor: i <= phaseIndex
                ? (isComplete ? '#22c55e' : colors.primary)
                : colors.muted,
            }}
          />
        ))}
      </View>

      {/* Sub-questions */}
      {progress.subQuestions && progress.subQuestions.length > 0 && (
        <View>
          <Pressable
            onPress={() => setShowQuestions(!showQuestions)}
            className="flex-row items-center gap-1 mb-1"
          >
            <BookOpen size={12} color={colors.mutedForeground} />
            <Text className="text-xs font-medium text-muted-foreground">
              Research angles ({progress.subQuestions.length})
            </Text>
            {showQuestions ? (
              <ChevronUp size={12} color={colors.mutedForeground} />
            ) : (
              <ChevronDown size={12} color={colors.mutedForeground} />
            )}
          </Pressable>
          {showQuestions && (
            <View className="gap-1 pl-4">
              {progress.subQuestions.map((q, i) => (
                <Text key={i} className="text-xs text-muted-foreground">
                  {i + 1}. {q}
                </Text>
              ))}
            </View>
          )}
        </View>
      )}

      {/* Current search query indicator */}
      {progress.currentQuery && !isComplete && (
        <View className="flex-row items-center gap-2 bg-muted/50 rounded-lg px-3 py-1.5">
          <Loader2 size={12} color={colors.mutedForeground} />
          <Text className="text-xs text-muted-foreground flex-1" numberOfLines={1}>
            {progress.currentQuery}
          </Text>
        </View>
      )}

      {/* Sources list (collapsed by default) */}
      {progress.sources && progress.sources.length > 0 && (
        <View>
          <Pressable
            onPress={() => setShowSources(!showSources)}
            className="flex-row items-center gap-1"
          >
            <ExternalLink size={12} color={colors.mutedForeground} />
            <Text className="text-xs font-medium text-muted-foreground">
              Sources ({progress.sources.length})
            </Text>
            {showSources ? (
              <ChevronUp size={12} color={colors.mutedForeground} />
            ) : (
              <ChevronDown size={12} color={colors.mutedForeground} />
            )}
          </Pressable>
          {showSources && (
            <View className="gap-1 pl-4 mt-1">
              {progress.sources.map((s) => (
                <Text key={s.id} className="text-xs text-primary" numberOfLines={1}>
                  [{s.id}] {s.title}
                </Text>
              ))}
            </View>
          )}
        </View>
      )}

      {/* Search count */}
      {progress.totalSearches !== undefined && isComplete && (
        <Text className="text-[10px] text-muted-foreground text-right">
          {progress.totalSearches} searches performed
        </Text>
      )}
    </View>
  );
}
