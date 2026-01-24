/**
 * Comparison Page: Alia vs ChatGPT
 * Ruta: /vs/chatgpt
 * Keywords: "alia vs chatgpt", "chatgpt alternative", "chatgpt comparison"
 */

import { View, Text, Pressable, ScrollView } from 'react-native';
import { Link } from 'expo-router';
import { SEOHead } from '@/components/seo/SEOHead';
import { StructuredData } from '@/components/seo/StructuredData';
import { META_PRESETS } from '@/lib/seo/meta-tags';
import { generateArticleSchema, generateBreadcrumbSchema } from '@/lib/seo/structured-data';

export default function AliaVsChatGPT() {
  const schemas = [
    generateArticleSchema({
      title: 'Alia vs ChatGPT - Comparison',
      description:
        'An honest comparison between Alia and ChatGPT, exploring differences in features, pricing, and capabilities.',
      author: 'Oxy Team',
      datePublished: '2026-01-24',
      url: 'https://alia.onl/vs/chatgpt',
    }),
    generateBreadcrumbSchema([
      { name: 'Home', url: 'https://alia.onl' },
      { name: 'Comparisons', url: 'https://alia.onl/vs' },
      { name: 'Alia vs ChatGPT', url: 'https://alia.onl/vs/chatgpt' },
    ]),
  ];

  return (
    <>
      <SEOHead {...META_PRESETS.vsChatGPT}>
        <StructuredData data={schemas} />
      </SEOHead>

      <ScrollView className="flex-1 bg-white dark:bg-zinc-950">
        {/* Hero */}
        <View className="px-6 py-16 max-w-4xl mx-auto">
          <Text className="text-sm font-semibold text-[#ca52e9] mb-4 text-center uppercase tracking-wide">
            Honest Comparison
          </Text>
          <Text className="text-5xl font-bold text-center mb-6 text-zinc-900 dark:text-white">
            Alia vs ChatGPT
          </Text>
          <Text className="text-xl text-center text-zinc-600 dark:text-zinc-400 max-w-3xl mx-auto">
            Both are excellent AI assistants. Here's an honest look at how they compare, so you can choose what fits your needs.
          </Text>
        </View>

        {/* Comparison Table */}
        <View className="px-6 pb-16 max-w-5xl mx-auto">
          <View className="bg-zinc-50 dark:bg-zinc-900 rounded-2xl p-8">
            <ComparisonRow
              feature="Contextual Memory"
              alia="Persistent across all conversations with automatic retrieval"
              chatgpt="Limited to current conversation only (except ChatGPT Plus)"
              aliaWins={true}
            />
            <ComparisonRow
              feature="AI Models"
              alia="Multiple models: GPT-4, Claude 3, Gemini - switch anytime"
              chatgpt="GPT-4 only (Plus), GPT-3.5 (Free)"
              aliaWins={true}
            />
            <ComparisonRow
              feature="Free Tier"
              alia="Generous free tier with advanced models"
              chatgpt="GPT-3.5 only on free tier"
              aliaWins={true}
            />
            <ComparisonRow
              feature="Pricing"
              alia="$20/month or pay-as-you-go credits"
              chatgpt="$20/month subscription (Plus)"
              aliaWins={false}
            />
            <ComparisonRow
              feature="API Access"
              alia="Included in Pro plan, OpenAI-compatible"
              chatgpt="Separate pricing, billed by tokens"
              aliaWins={true}
            />
            <ComparisonRow
              feature="Custom Roles"
              alia="Create and save custom AI personas"
              chatgpt="Custom instructions available"
              aliaWins={true}
            />
            <ComparisonRow
              feature="Brand Recognition"
              alia="Newer, growing community"
              chatgpt="Industry leader, massive user base"
              aliaWins={false}
            />
            <ComparisonRow
              feature="Mobile Apps"
              alia="iOS, Android, Web"
              chatgpt="iOS, Android, Web"
              aliaWins={false}
            />
          </View>
        </View>

        {/* Key Differences */}
        <View className="px-6 py-16 bg-zinc-50 dark:bg-zinc-900">
          <View className="max-w-4xl mx-auto">
            <Text className="text-3xl font-bold text-center mb-12 text-zinc-900 dark:text-white">
              Key differences
            </Text>
            <View className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <DifferenceCard
                title="Choose Alia if..."
                points={[
                  'You want access to multiple AI models',
                  'Contextual memory is important to you',
                  'You need a developer-friendly API',
                  'You prefer pay-as-you-go pricing',
                  'You want custom AI personas',
                ]}
                color="purple"
              />
              <DifferenceCard
                title="Choose ChatGPT if..."
                points={[
                  'You prefer the most established brand',
                  'You only need GPT models',
                  'You want the largest community',
                  'You use ChatGPT plugins extensively',
                  'You need DALL-E image generation',
                ]}
                color="green"
              />
            </View>
          </View>
        </View>

        {/* The Honest Truth */}
        <View className="px-6 py-16 max-w-3xl mx-auto">
          <Text className="text-3xl font-bold mb-6 text-zinc-900 dark:text-white">
            The honest truth
          </Text>
          <Text className="text-lg text-zinc-600 dark:text-zinc-400 mb-6 leading-relaxed">
            ChatGPT pioneered accessible AI chat and remains an excellent choice. It's polished, reliable, and has the largest user base.
          </Text>
          <Text className="text-lg text-zinc-600 dark:text-zinc-400 mb-6 leading-relaxed">
            Alia offers something different: the flexibility to choose between AI models, enhanced memory that persists across conversations, and pricing that scales with your usage instead of a flat subscription.
          </Text>
          <Text className="text-lg text-zinc-600 dark:text-zinc-400 mb-8 leading-relaxed">
            For most users, it comes down to this: Do you want the stability of ChatGPT, or the flexibility and memory of Alia?
          </Text>
          <Text className="text-lg font-semibold text-zinc-900 dark:text-white mb-4">
            Try both. They're both free to start.
          </Text>
          <Link href="/register" asChild>
            <Pressable className="bg-[#ca52e9] px-8 py-4 rounded-full">
              <Text className="text-white font-semibold text-center">Try Alia free</Text>
            </Pressable>
          </Link>
        </View>
      </ScrollView>
    </>
  );
}

function ComparisonRow({
  feature,
  alia,
  chatgpt,
  aliaWins,
}: {
  feature: string;
  alia: string;
  chatgpt: string;
  aliaWins: boolean;
}) {
  return (
    <View className="py-6 border-b border-zinc-200 dark:border-zinc-800 last:border-b-0">
      <Text className="text-lg font-semibold mb-4 text-zinc-900 dark:text-white">{feature}</Text>
      <View className="grid grid-cols-2 gap-6">
        <View className={aliaWins ? 'opacity-100' : 'opacity-60'}>
          <Text className="text-sm font-semibold text-[#ca52e9] mb-2">Alia</Text>
          <Text className="text-zinc-700 dark:text-zinc-300">{alia}</Text>
        </View>
        <View className={!aliaWins ? 'opacity-100' : 'opacity-60'}>
          <Text className="text-sm font-semibold text-green-600 mb-2">ChatGPT</Text>
          <Text className="text-zinc-700 dark:text-zinc-300">{chatgpt}</Text>
        </View>
      </View>
    </View>
  );
}

function DifferenceCard({
  title,
  points,
  color,
}: {
  title: string;
  points: string[];
  color: 'purple' | 'green';
}) {
  return (
    <View className="bg-white dark:bg-zinc-800 p-8 rounded-2xl shadow-sm">
      <Text className="text-2xl font-bold mb-6 text-zinc-900 dark:text-white">{title}</Text>
      <View className="space-y-4">
        {points.map((point, index) => (
          <View key={index} className="flex-row gap-3">
            <Text className={color === 'purple' ? 'text-[#ca52e9]' : 'text-green-600'}>✓</Text>
            <Text className="flex-1 text-zinc-700 dark:text-zinc-300 leading-relaxed">{point}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}
