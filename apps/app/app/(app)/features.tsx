/**
 * Features Page - SEO optimizada
 * Ruta: /features
 */

import { View, Text, Pressable, ScrollView } from 'react-native';
import { Link } from 'expo-router';
import { SEOHead } from '@/components/seo/SEOHead';
import { StructuredData } from '@/components/seo/StructuredData';
import { META_PRESETS } from '@/lib/seo/meta-tags';
import { STRUCTURED_DATA_PRESETS } from '@/lib/seo/structured-data';

export default function Features() {
  return (
    <>
      <SEOHead {...META_PRESETS.features}>
        <StructuredData data={STRUCTURED_DATA_PRESETS.features} />
      </SEOHead>

      <ScrollView className="flex-1 bg-white dark:bg-zinc-950">
        {/* Hero */}
        <View className="px-6 py-16 md:py-20 max-w-6xl mx-auto">
          <Text className="text-5xl font-bold text-center mb-6 text-zinc-900 dark:text-white">
            Everything you need in an AI assistant
          </Text>
          <Text className="text-xl text-center text-zinc-600 dark:text-zinc-400 mb-12 max-w-3xl mx-auto">
            Alia combines the best AI models, powerful features, and a clean interface to help you work smarter.
          </Text>
        </View>

        {/* Features */}
        <View className="px-6 pb-16 max-w-6xl mx-auto">
          <View className="space-y-16">
            <FeatureSection
              title="Contextual Memory"
              description="Alia remembers everything"
              details="Unlike basic chatbots, Alia maintains context across all your conversations. It remembers your preferences, past discussions, and important details—making every interaction more relevant and productive."
              highlights={[
                'Persistent memory across sessions',
                'Automatic context retrieval',
                'Custom memory preferences',
                'Full conversation history',
              ]}
              reversed={false}
            />

            <FeatureSection
              title="Multiple AI Models"
              description="Switch between the best models seamlessly"
              details="Access GPT-4, Claude 3, Google Gemini, and more—all in one place. Choose the perfect model for your task or let Alia route automatically to the best option."
              highlights={[
                'GPT-4 Turbo & GPT-4o',
                'Claude 3 (Opus, Sonnet, Haiku)',
                'Google Gemini Pro',
                'Automatic model routing',
              ]}
              reversed={true}
            />

            <FeatureSection
              title="Custom Roles & Personas"
              description="Create AI assistants tailored to your workflow"
              details="Build specialized AI personas for different tasks. Coding expert, creative writer, data analyst, or teacher—configure once, use forever."
              highlights={[
                'Pre-built role library',
                'Custom system prompts',
                'Shareable personas',
                'Team collaboration',
              ]}
              reversed={false}
            />

            <FeatureSection
              title="Developer API"
              description="Integrate AI into your applications"
              details="OpenAI-compatible REST API with comprehensive documentation. Build AI-powered features into your apps with just a few lines of code."
              highlights={[
                'OpenAI API compatible',
                'RESTful architecture',
                'SDKs for popular languages',
                'Detailed documentation',
              ]}
              reversed={true}
            />

            <FeatureSection
              title="Multilingual Support"
              description="Chat in any language"
              details="Alia natively supports 50+ languages with intelligent translation and cultural context understanding. No need to switch apps."
              highlights={[
                '50+ languages supported',
                'Native understanding',
                'Automatic language detection',
                'Cultural context awareness',
              ]}
              reversed={false}
            />
          </View>
        </View>

        {/* CTA */}
        <View className="px-6 py-16 bg-[#ca52e9]">
          <View className="max-w-3xl mx-auto text-center">
            <Text className="text-4xl font-bold mb-4 text-white">
              Experience the difference
            </Text>
            <Text className="text-xl text-white/90 mb-8">
              Start using Alia today. No credit card required.
            </Text>
            <Link href="/register" asChild>
              <Pressable className="bg-white px-10 py-5 rounded-full mx-auto">
                <Text className="text-[#ca52e9] font-bold text-lg">Get started free</Text>
              </Pressable>
            </Link>
          </View>
        </View>
      </ScrollView>
    </>
  );
}

function FeatureSection({
  title,
  description,
  details,
  highlights,
  reversed,
}: {
  title: string;
  description: string;
  details: string;
  highlights: string[];
  reversed: boolean;
}) {
  return (
    <View className={`flex-row ${reversed ? 'flex-row-reverse' : ''} gap-12 items-center`}>
      <View className="flex-1">
        <Text className="text-sm font-semibold text-[#ca52e9] mb-2 uppercase tracking-wide">
          {description}
        </Text>
        <Text className="text-3xl font-bold mb-4 text-zinc-900 dark:text-white">{title}</Text>
        <Text className="text-lg text-zinc-600 dark:text-zinc-400 mb-6 leading-relaxed">
          {details}
        </Text>
        <View className="space-y-3">
          {highlights.map((item, index) => (
            <View key={index} className="flex-row items-center gap-3">
              <View className="w-1.5 h-1.5 rounded-full bg-[#ca52e9]" />
              <Text className="text-zinc-700 dark:text-zinc-300">{item}</Text>
            </View>
          ))}
        </View>
      </View>
      <View className="flex-1 bg-zinc-100 dark:bg-zinc-900 h-96 rounded-2xl" />
    </View>
  );
}
