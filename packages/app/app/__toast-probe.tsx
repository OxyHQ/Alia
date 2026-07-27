import { Pressable, Text, View } from 'react-native';
import { toast } from '@oxyhq/bloom/toast';

export default function ToastProbe() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 }}>
      <Pressable id="probe-success" onPress={() => toast.success('Probe success toast')}>
        <Text>Fire success</Text>
      </Pressable>
      <Pressable id="probe-error" onPress={() => toast.error('Probe error toast')}>
        <Text>Fire error</Text>
      </Pressable>
    </View>
  );
}
