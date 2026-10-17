import type { ComponentRef } from 'react';
import type { TextInput } from 'react-native';

/**
 * What a ref to a `TextInput` holds. `ComponentRef`, not `TextInput` itself: React Native 0.88
 * types `TextInput` as a function component, so the class is no longer its instance type, and
 * `focus()` is only on the instance.
 */
export type TextInputHandle = ComponentRef<typeof TextInput>;
