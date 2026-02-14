import { View, useWindowDimensions } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useNavigation } from "expo-router";
import { useRouter } from "expo-router";
import { DrawerNavigationProp } from "@react-navigation/drawer";
import { Menu, ArrowLeft } from "lucide-react-native";

interface SettingsHeaderProps {
  title: string;
  subtitle?: string;
  showBack?: boolean;
  onBack?: () => void;
}

export function SettingsHeader({ title, subtitle, showBack = false, onBack }: SettingsHeaderProps) {
  const navigation = useNavigation<DrawerNavigationProp<any>>();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const isLargeScreen = width >= 768;

  const handleBack = () => {
    if (onBack) {
      onBack();
    } else {
      router.back();
    }
  };

  return (
    <View className="flex-row items-center gap-2 px-4 h-14 border-b border-border">
      {!isLargeScreen && (
        <Button
          variant="ghost"
          size="icon"
          onPress={() => navigation.toggleDrawer()}
          className="h-9 w-9 rounded-full"
        >
          <Menu size={20} className="text-muted-foreground" />
        </Button>
      )}
      {showBack && (
        <Button
          variant="ghost"
          size="icon"
          onPress={handleBack}
          className="h-9 w-9 rounded-full"
        >
          <ArrowLeft size={20} className="text-muted-foreground" />
        </Button>
      )}
      <View className="flex-1">
        <Text className="text-lg font-bold">{title}</Text>
        {subtitle && (
          <Text className="text-sm text-muted-foreground">{subtitle}</Text>
        )}
      </View>
    </View>
  );
}
