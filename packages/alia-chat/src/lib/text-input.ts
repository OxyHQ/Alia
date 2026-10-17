import type { ComponentRef } from 'react';
import type { TextInput } from 'react-native';

/**
 * What a ref to a `TextInput` holds. `ComponentRef`, not `TextInput` itself: React Native 0.88
 * types `TextInput` as a function component, so the class is no longer its instance type, and
 * `focus()` is only on the instance. An interface rather than an alias, so a declaration that
 * returns one can name it: on 0.88 the instance type lives in a file React Native does not export.
 */
export interface TextInputHandle extends ComponentRef<typeof TextInput> {}
