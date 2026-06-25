import { View, Text } from "react-native";
import { Image } from "expo-image";
import { useOxy } from "@oxyhq/services";

interface UserAvatarProps {
  size?: number;
}

export function UserAvatar({ size = 24 }: UserAvatarProps) {
  const { user, oxyServices } = useOxy();

  const initial = (
    user?.name?.displayName?.[0] || user?.username?.[0] || "U"
  ).toUpperCase();

  const avatarUrl = user?.avatar
    ? oxyServices.getFileDownloadUrl(user.avatar, "thumb")
    : null;

  return (
    <View
      className="rounded-full bg-muted items-center justify-center overflow-hidden"
      style={{ width: size, height: size }}
    >
      {avatarUrl ? (
        <Image
          source={{ uri: avatarUrl }}
          style={{ width: size, height: size }}
          contentFit="cover"
          transition={150}
        />
      ) : (
        <Text
          className="font-bold text-foreground"
          style={{ fontSize: size * 0.4 }}
        >
          {initial}
        </Text>
      )}
    </View>
  );
}
