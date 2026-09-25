// Native: re-export react-native-keyboard-controller components
// No KeyboardProvider: OxyProvider mounts the app's only one (see app/_layout.tsx).
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';

export {
  KeyboardAwareScrollView,
  KeyboardAvoidingView,
} from 'react-native-keyboard-controller';

/**
 * The room under a bottom-anchored control for the gesture bar, while the
 * gesture bar is what lies under it.
 *
 * With the keyboard up, a keyboard-avoiding host already ends at the keyboard's
 * top edge, and the keyboard covers the gesture bar. Keeping this room then
 * counts the bar twice: the chat's composer floated a bar's height above the
 * keyboard, with the transcript showing through the gap (Pixel 8a,
 * `docs/native-validation.mdx`). It follows the keyboard's own animation, so
 * the control settles onto the keyboard as it rises instead of jumping after.
 */
export function KeyboardSafeAreaFloor({ inset }: { inset: number }) {
  const { progress } = useReanimatedKeyboardAnimation();
  const style = useAnimatedStyle(() => ({ height: inset * (1 - progress.value) }), [inset]);
  return <Animated.View style={style} />;
}
