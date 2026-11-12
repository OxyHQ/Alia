// Local navigation check — never committed. /__nav
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

export default function Nav() {
  const router = useRouter();
  const btn = (id: string, label: string, go: () => void) => (
    <Pressable key={id} testID={id} onPress={go} style={{ padding: 12 }}>
      <Text>{label}</Text>
    </Pressable>
  );
  return (
    <View>
      {btn('string-push', 'push string', () => router.push('/@clippobot'))}
      {btn('string-replace', 'replace string', () => router.replace('/@clippobot'))}
      {btn('object-push', 'push object', () =>
        router.push({ pathname: '/(app)/[username]', params: { username: '@clippobot' } } as never),
      )}
      {btn('string-details', 'push @x/details', () => router.push('/@clippobot?threadId=abc'))}
    </View>
  );
}
