import { Easing, FadeInUp } from 'react-native-reanimated';

const easeOut = Easing.bezier(0.16, 1, 0.3, 1);

export const planPreviewEnter = FadeInUp.duration(220).easing(easeOut);
export const chatMessageEnter = FadeInUp.duration(220).easing(easeOut);
