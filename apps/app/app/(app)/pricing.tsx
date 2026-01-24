/**
 * Pricing Page - SEO optimizada
 * Ruta: /pricing
 */

import { View, Text, Pressable, ScrollView } from 'react-native';
import { Link } from 'expo-router';
import { SEOHead } from '@/components/seo/SEOHead';
import { StructuredData } from '@/components/seo/StructuredData';
import { META_PRESETS } from '@/lib/seo/meta-tags';
import { STRUCTURED_DATA_PRESETS } from '@/lib/seo/structured-data';

export default function Pricing() {
  return (
    <>
      <SEOHead {...META_PRESETS.pricing}>
        <StructuredData data={STRUCTURED_DATA_PRESETS.pricing} />
      </SEOHead>

      <ScrollView className="flex-1 bg-white dark:bg-zinc-950">
        {/* Hero */}
        <View className="px-6 py-16 max-w-5xl mx-auto text-center">
          <Text className="text-5xl font-bold mb-6 text-zinc-900 dark:text-white">
            Simple, transparent pricing
          </Text>
          <Text className="text-xl text-zinc-600 dark:text-zinc-400 mb-4">
            Start free, pay as you grow. No subscriptions.
          </Text>
          <Text className="text-zinc-500 dark:text-zinc-500">
            Credits never expire • Cancel anytime • No hidden fees
          </Text>
        </View>

        {/* Pricing Cards */}
        <View className="px-6 pb-16 max-w-6xl mx-auto">
          <View className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {/* Free Tier */}
            <PricingCard
              name="Free"
              price="$0"
              period="forever"
              description="Perfect for trying out Alia"
              features={[
                '10,000 credits/month',
                'Access to GPT-3.5',
                'Basic memory',
                'Community support',
                'Web & mobile apps',
              ]}
              cta="Start free"
              ctaHref="/register"
              highlighted={false}
            />

            {/* Pro Tier */}
            <PricingCard
              name="Pro"
              price="$20"
              period="/ month"
              description="For power users and professionals"
              features={[
                '500,000 credits/month',
                'GPT-4, Claude 3, Gemini',
                'Advanced memory',
                'Priority support',
                'API access',
                'Custom roles',
              ]}
              cta="Get started"
              ctaHref="/register"
              highlighted={true}
            />

            {/* Enterprise */}
            <PricingCard
              name="Enterprise"
              price="Custom"
              period=""
              description="For teams and organizations"
              features={[
                'Unlimited credits',
                'All AI models',
                'Dedicated support',
                'SSO & SAML',
                'Custom deployment',
                'SLA guarantee',
              ]}
              cta="Contact sales"
              ctaHref="mailto:sales@alia.onl"
              highlighted={false}
            />
          </View>
        </View>

        {/* FAQ Section */}
        <View className="px-6 py-16 bg-zinc-50 dark:bg-zinc-900">
          <View className="max-w-3xl mx-auto">
            <Text className="text-3xl font-bold text-center mb-12 text-zinc-900 dark:text-white">
              Frequently asked questions
            </Text>
            <View className="space-y-8">
              <FAQItem
                question="How does the credit system work?"
                answer="Credits are consumed based on the AI model and length of responses. GPT-3.5 uses fewer credits, while GPT-4 uses more. Your credits never expire and roll over month to month."
              />
              <FAQItem
                question="Can I cancel anytime?"
                answer="Absolutely! There are no contracts or commitments. You can cancel your plan at any time and keep using your remaining credits."
              />
              <FAQItem
                question="What happens if I run out of credits?"
                answer="You can purchase additional credit packs at any time, or upgrade to a higher plan. Your account won't be locked—you'll just need to add more credits to continue."
              />
              <FAQItem
                question="Is there a student discount?"
                answer="Yes! Students and educators get 50% off Pro plans. Contact us with your .edu email to verify."
              />
              <FAQItem
                question="Do you offer refunds?"
                answer="We offer a 14-day money-back guarantee on all paid plans. If you're not satisfied, we'll refund you in full."
              />
            </View>
          </View>
        </View>

        {/* Final CTA */}
        <View className="px-6 py-16">
          <View className="max-w-3xl mx-auto text-center">
            <Text className="text-4xl font-bold mb-6 text-zinc-900 dark:text-white">
              Ready to get started?
            </Text>
            <Text className="text-xl text-zinc-600 dark:text-zinc-400 mb-8">
              Join thousands of users who trust Alia for their AI needs.
            </Text>
            <Link href="/register" asChild>
              <Pressable className="bg-[#ca52e9] px-10 py-5 rounded-full mx-auto">
                <Text className="text-white font-bold text-lg">Start free today</Text>
              </Pressable>
            </Link>
          </View>
        </View>
      </ScrollView>
    </>
  );
}

function PricingCard({
  name,
  price,
  period,
  description,
  features,
  cta,
  ctaHref,
  highlighted,
}: {
  name: string;
  price: string;
  period: string;
  description: string;
  features: string[];
  cta: string;
  ctaHref: string;
  highlighted: boolean;
}) {
  return (
    <View
      className={`p-8 rounded-2xl ${
        highlighted
          ? 'bg-[#ca52e9] shadow-2xl scale-105'
          : 'bg-white dark:bg-zinc-900 border-2 border-zinc-200 dark:border-zinc-800'
      }`}
    >
      <Text
        className={`text-2xl font-bold mb-2 ${highlighted ? 'text-white' : 'text-zinc-900 dark:text-white'}`}
      >
        {name}
      </Text>
      <View className="flex-row items-baseline mb-2">
        <Text
          className={`text-5xl font-bold ${highlighted ? 'text-white' : 'text-zinc-900 dark:text-white'}`}
        >
          {price}
        </Text>
        <Text className={`ml-2 ${highlighted ? 'text-white/80' : 'text-zinc-600 dark:text-zinc-400'}`}>
          {period}
        </Text>
      </View>
      <Text
        className={`mb-6 ${highlighted ? 'text-white/90' : 'text-zinc-600 dark:text-zinc-400'}`}
      >
        {description}
      </Text>
      <View className="space-y-3 mb-8">
        {features.map((feature, index) => (
          <View key={index} className="flex-row items-center gap-3">
            <View
              className={`w-5 h-5 rounded-full ${highlighted ? 'bg-white/20' : 'bg-zinc-100 dark:bg-zinc-800'}`}
            />
            <Text className={highlighted ? 'text-white' : 'text-zinc-700 dark:text-zinc-300'}>
              {feature}
            </Text>
          </View>
        ))}
      </View>
      <Link href={ctaHref} asChild>
        <Pressable
          className={`py-4 rounded-full ${
            highlighted ? 'bg-white' : 'bg-[#ca52e9]'
          }`}
        >
          <Text
            className={`text-center font-semibold text-lg ${
              highlighted ? 'text-[#ca52e9]' : 'text-white'
            }`}
          >
            {cta}
          </Text>
        </Pressable>
      </Link>
    </View>
  );
}

function FAQItem({ question, answer }: { question: string; answer: string }) {
  return (
    <View>
      <Text className="text-xl font-semibold mb-3 text-zinc-900 dark:text-white">{question}</Text>
      <Text className="text-zinc-600 dark:text-zinc-400 leading-relaxed">{answer}</Text>
    </View>
  );
}
