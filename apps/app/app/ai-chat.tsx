/**
 * Landing Page SEO-optimizada para "AI Chat"
 * Ruta: /ai-chat
 */

import { View, Text, Pressable, ScrollView } from 'react-native';
import { Link } from 'expo-router';
import { SEOHead } from '@/components/seo/SEOHead';
import { StructuredData } from '@/components/seo/StructuredData';
import { META_PRESETS } from '@/lib/seo/meta-tags';
import {
  generateWebApplicationSchema,
  generateFAQSchema,
  generateBreadcrumbSchema,
} from '@/lib/seo/structured-data';

export default function AIChat() {
  // Structured data para SEO
  const schemas = [
    generateWebApplicationSchema(),
    generateFAQSchema([
      {
        question: 'What is AI chat?',
        answer:
          'AI chat is a conversational interface powered by artificial intelligence that allows you to have natural, intelligent conversations with AI models. Alia provides advanced AI chat with memory, context awareness, and multiple model support.',
      },
      {
        question: 'Is Alia AI chat free?',
        answer:
          'Yes! Alia offers a generous free tier with access to advanced AI models. You can start chatting immediately without a credit card.',
      },
      {
        question: 'How is Alia different from other AI chats?',
        answer:
          'Alia stands out with persistent memory across conversations, the ability to switch between multiple AI models, custom personas, and a developer-friendly API. All in one clean interface.',
      },
      {
        question: 'Can I use Alia for work?',
        answer:
          'Absolutely! Alia is perfect for coding, writing, research, data analysis, and creative work. Many professionals use Alia as their daily AI assistant.',
      },
    ]),
    generateBreadcrumbSchema([
      { name: 'Home', url: 'https://alia.onl' },
      { name: 'AI Chat', url: 'https://alia.onl/ai-chat' },
    ]),
  ];

  return (
    <>
      <SEOHead {...META_PRESETS.aiChat}>
        <StructuredData data={schemas} />
      </SEOHead>

      <ScrollView className="flex-1 bg-white dark:bg-zinc-950">
        {/* Hero Section */}
        <View className="px-6 py-16 md:py-24 max-w-5xl mx-auto">
          <View className="text-center items-center">
            <Text className="text-5xl md:text-6xl font-bold text-zinc-900 dark:text-white mb-6">
              Chat with AI that remembers
            </Text>
            <Text className="text-xl md:text-2xl text-zinc-600 dark:text-zinc-400 mb-8 max-w-3xl">
              Have intelligent conversations with Alia. Advanced AI that understands context, remembers your preferences, and adapts to your needs.
            </Text>
            <View className="flex-row gap-4">
              <Link href="/register" asChild>
                <Pressable className="bg-[#ca52e9] px-8 py-4 rounded-full">
                  <Text className="text-white font-semibold text-lg">Start chatting free</Text>
                </Pressable>
              </Link>
              <Link href="/features" asChild>
                <Pressable className="border-2 border-zinc-300 dark:border-zinc-700 px-8 py-4 rounded-full">
                  <Text className="text-zinc-900 dark:text-white font-semibold text-lg">
                    See features
                  </Text>
                </Pressable>
              </Link>
            </View>
          </View>
        </View>

        {/* Features Grid */}
        <View className="px-6 py-16 bg-zinc-50 dark:bg-zinc-900">
          <View className="max-w-6xl mx-auto">
            <Text className="text-3xl font-bold text-center mb-12 text-zinc-900 dark:text-white">
              Why choose Alia?
            </Text>
            <View className="grid grid-cols-1 md:grid-cols-3 gap-8">
              <FeatureCard
                title="Contextual Memory"
                description="Alia remembers your conversations, preferences, and context across sessions. Pick up right where you left off."
              />
              <FeatureCard
                title="Multiple AI Models"
                description="Switch between GPT-4, Claude, Gemini, and more. Get the best response for every task."
              />
              <FeatureCard
                title="Custom Personas"
                description="Create AI assistants tailored to your needs. Coding expert, creative writer, or data analyst."
              />
              <FeatureCard
                title="Developer API"
                description="OpenAI-compatible API to integrate Alia into your apps. Simple, powerful, well-documented."
              />
              <FeatureCard
                title="Multilingual"
                description="Chat in 50+ languages with native understanding. Alia speaks your language."
              />
              <FeatureCard
                title="Privacy First"
                description="Your conversations are private and secure. We don't train models on your data."
              />
            </View>
          </View>
        </View>

        {/* CTA Section */}
        <View className="px-6 py-16">
          <View className="max-w-3xl mx-auto text-center">
            <Text className="text-4xl font-bold mb-6 text-zinc-900 dark:text-white">
              Ready to start chatting?
            </Text>
            <Text className="text-xl text-zinc-600 dark:text-zinc-400 mb-8">
              Join thousands of users who trust Alia for their AI conversations.
            </Text>
            <Link href="/register" asChild>
              <Pressable className="bg-[#ca52e9] px-10 py-5 rounded-full mx-auto">
                <Text className="text-white font-bold text-lg">Get started free</Text>
              </Pressable>
            </Link>
          </View>
        </View>
      </ScrollView>
    </>
  );
}

function FeatureCard({ title, description }: { title: string; description: string }) {
  return (
    <View className="bg-white dark:bg-zinc-800 p-6 rounded-2xl shadow-sm">
      <Text className="text-xl font-semibold mb-3 text-zinc-900 dark:text-white">{title}</Text>
      <Text className="text-zinc-600 dark:text-zinc-400 leading-relaxed">{description}</Text>
    </View>
  );
}
