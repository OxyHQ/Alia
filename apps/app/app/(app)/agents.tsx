import { View, ScrollView, Linking } from 'react-native';
import { Image } from 'expo-image';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import {
  Fingerprint,
  Brain,
  Sparkles,
  MessageSquare,
  Send,
  MessageCircle,
  type LucideIcon,
} from 'lucide-react-native';
import { useTranslation } from '@/hooks/useTranslation';

const TELEGRAM_BOT_URL = 'https://t.me/AliaBot'; // TODO: Replace with actual bot URL

export default function AgentsScreen() {
  const { t } = useTranslation();

  const FEATURES: {
    icon: LucideIcon;
    iconColor: string;
    iconBg: string;
    titleKey: string;
    descriptionKey: string;
  }[] = [
    {
      icon: Fingerprint,
      iconColor: 'text-blue-500',
      iconBg: 'bg-blue-500/15',
      titleKey: 'agents.uniqueIdentity',
      descriptionKey: 'agents.uniqueIdentityDesc',
    },
    {
      icon: Brain,
      iconColor: 'text-teal-500',
      iconBg: 'bg-teal-500/15',
      titleKey: 'agents.persistentMemory',
      descriptionKey: 'agents.persistentMemoryDesc',
    },
    {
      icon: Sparkles,
      iconColor: 'text-yellow-500',
      iconBg: 'bg-yellow-500/15',
      titleKey: 'agents.customSkills',
      descriptionKey: 'agents.customSkillsDesc',
    },
    {
      icon: MessageSquare,
      iconColor: 'text-muted-foreground',
      iconBg: 'bg-muted',
      titleKey: 'agents.worksInMessenger',
      descriptionKey: 'agents.worksInMessengerDesc',
    },
  ];

  const handleGetStarted = () => {
    Linking.openURL(TELEGRAM_BOT_URL);
  };

  return (
    <View className="flex-1 bg-background">
      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View className="px-5 pt-6 pb-4">
          <Text className="text-2xl font-bold text-foreground">{t('agents.title')}</Text>
        </View>

        {/* Hero Illustration */}
        <View className="items-center py-8 px-5">
          <View className="w-56 h-56 items-center justify-center">
            {/* App logo */}
            <Image
              source={require('@/assets/images/logo.png')}
              style={{ width: 100, height: 44 }}
              contentFit="contain"
              className="z-10"
            />

            {/* Floating messenger icons */}
            <View className="absolute top-0 left-4">
              <View className="w-10 h-10 rounded-full bg-blue-500/15 items-center justify-center">
                <Send size={18} className="text-blue-500" />
              </View>
            </View>
            <View className="absolute top-2 right-0">
              <View className="w-10 h-10 rounded-full bg-blue-600/15 items-center justify-center">
                <MessageSquare size={18} className="text-blue-600" />
              </View>
            </View>
            <View className="absolute bottom-2 left-0">
              <View className="w-10 h-10 rounded-full bg-green-500/15 items-center justify-center">
                <MessageCircle size={18} className="text-green-500" />
              </View>
            </View>
            <View className="absolute bottom-0 right-4">
              <View className="w-10 h-10 rounded-full bg-green-600/15 items-center justify-center">
                <MessageCircle size={18} className="text-green-600" />
              </View>
            </View>
          </View>
        </View>

        {/* Main Heading */}
        <View className="items-center px-5 mb-6">
          <Text className="text-3xl font-bold text-foreground text-center">
            {t('agents.claimAgent')}
          </Text>
        </View>

        {/* Feature Cards */}
        <View className="px-5 mb-8">
          <View className="flex-row flex-wrap gap-3 max-w-3xl mx-auto justify-center">
            {FEATURES.map((feature, index) => {
              const Icon = feature.icon;
              return (
                <View
                  key={index}
                  className="w-[46%] md:w-[22%] rounded-2xl bg-surface border border-border p-4"
                >
                  <View
                    className={`w-10 h-10 rounded-xl ${feature.iconBg} items-center justify-center mb-3`}
                  >
                    <Icon size={20} className={feature.iconColor} />
                  </View>
                  <Text className="text-sm font-semibold text-foreground mb-1">
                    {t(feature.titleKey)}
                  </Text>
                  <Text className="text-xs text-muted-foreground leading-4">
                    {t(feature.descriptionKey)}
                  </Text>
                </View>
              );
            })}
          </View>
        </View>

        {/* CTA Button */}
        <View className="items-center px-5 mb-8">
          <Button
            onPress={handleGetStarted}
            className="flex-row items-center gap-2 rounded-full px-6"
            size="lg"
          >
            <Send size={18} className="text-primary-foreground" />
            <Text className="text-sm font-medium text-primary-foreground">
              {t('agents.getStartedTelegram')}
            </Text>
          </Button>
        </View>

        {/* Coming Soon Section */}
        <View className="items-center px-5 pb-12">
          <View className="flex-row items-center gap-3 mb-4 w-full max-w-xs">
            <View className="flex-1 h-px bg-border" />
            <Text className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">
              {t('agents.comingSoon')}
            </Text>
            <View className="flex-1 h-px bg-border" />
          </View>
          <View className="flex-row items-center gap-4">
            <View className="items-center gap-1.5">
              <View className="w-10 h-10 rounded-full bg-green-500/15 items-center justify-center">
                <MessageCircle size={20} className="text-green-500" />
              </View>
              <Text className="text-[10px] text-muted-foreground">WhatsApp</Text>
            </View>
            <View className="items-center gap-1.5">
              <View className="w-10 h-10 rounded-full bg-blue-500/15 items-center justify-center">
                <MessageSquare size={20} className="text-blue-500" />
              </View>
              <Text className="text-[10px] text-muted-foreground">Messenger</Text>
            </View>
            <View className="items-center gap-1.5">
              <View className="w-10 h-10 rounded-full bg-green-600/15 items-center justify-center">
                <MessageCircle size={20} className="text-green-600" />
              </View>
              <Text className="text-[10px] text-muted-foreground">Line</Text>
            </View>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
