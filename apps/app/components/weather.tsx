import { View, Text } from "react-native";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Wind, Droplets, Sun, Cloud } from "lucide-react-native";

interface WeatherCardProps {
  city: string;
  temperature: number;
  weatherCode: number;
  humidity: number;
  wind: number;
}

export default function WeatherCard({
  city,
  temperature,
  weatherCode,
  humidity,
  wind,
}: WeatherCardProps) {
  const getWeatherIcon = (code: number) => {
    // WMO Weather interpretation codes
    // https://open-meteo.com/en/docs
    if (code === 0) {
      // Clear sky
      return (
        <Sun
          size={50}
          className="absolute right-4 top-4 h-12 w-12 text-yellow-200"
        />
      );
    } else if (code >= 1 && code <= 3) {
      // Partly cloudy
      return (
        <Cloud
          size={50}
          color="gray"
          className="absolute right-4 top-4 h-12 w-12 text-gray-400"
        />
      );
    }
    return (
      <Cloud
        color="gray"
        size={50}
        className="absolute right-4 top-4 h-12 w-12 text-gray-400"
      />
    );
  };

  return (
    <Card className="x-auto mt-4 w-full">
      <CardHeader className="flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium">{city}</CardTitle>
        {getWeatherIcon(weatherCode)}
      </CardHeader>
      <CardContent>
        <Text className="text-4xl font-bold">{temperature}°F</Text>
        <View className="mt-4 flex-row justify-between">
          <View className="flex-row items-center gap-1 space-x-2">
            <Droplets size={16} className="mr-1 h-4 w-4 text-gray-500" />
            <Text className="text-sm">{humidity}% Humidity</Text>
          </View>
          <View className="flex-row items-center gap-1 space-x-2">
            <Wind size={16} className="mr-1 h-4 w-4 text-gray-500" />
            <Text className="text-sm">{wind} mph</Text>
          </View>
        </View>
      </CardContent>
    </Card>
  );
}
