// Native: re-export react-native-keyboard-controller components
// No KeyboardProvider: OxyProvider mounts the app's only one (see app/_layout.tsx).
export {
  KeyboardAwareScrollView,
  KeyboardAvoidingView,
} from 'react-native-keyboard-controller';
