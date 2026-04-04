import { View } from "react-native";
import { Skeleton } from "@/components/ui/skeleton";

export function SidebarSkeleton() {
  return (
    <View className="gap-2 px-2 py-1">
      {Array.from({ length: 6 }).map((_, i) => (
        <View key={i} className="flex-row items-center gap-2.5 py-1.5">
          <Skeleton className="h-5 w-5 rounded-full" />
          <View className="flex-1 gap-1.5">
            <Skeleton className="h-3 rounded" style={{ width: `${60 + (i % 3) * 15}%` }} />
            <Skeleton className="h-2.5 w-2/5 rounded" />
          </View>
        </View>
      ))}
    </View>
  );
}
