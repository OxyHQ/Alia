import type { ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

export interface InertWhenProps {
  /** The content is out of reach while true: not focusable, not read by a screen reader. */
  inert: boolean;
  children?: ReactNode;
}

/**
 * Takes what it wraps out of reach while something is drawn over it, and keeps it mounted.
 *
 * It is Bloom's `OverlayInertBoundary` (same props per platform) driven by this in-tree overlay
 * instead of by Bloom's global modal registry: that registry is app-wide, so registering the
 * view there would make the host's sidebar and header inert too, where only the chat under the
 * view must be. Web gets `inert` + `aria-hidden` and no box (`display: contents`, so layout is
 * what it was); Android `no-hide-descendants`; iOS `accessibilityElementsHidden`.
 */
export function InertWhen({ inert, children }: InertWhenProps) {
  if (Platform.OS === 'web') {
    return (
      <View
        testID="inert-when"
        style={styles.web}
        aria-hidden={inert ? true : undefined}
        {...(inert ? { inert: true } : null)}
      >
        {children}
      </View>
    );
  }
  return (
    <View
      testID="inert-when"
      collapsable={false}
      style={styles.native}
      importantForAccessibility={inert ? 'no-hide-descendants' : 'auto'}
      accessibilityElementsHidden={inert}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  native: { flex: 1 },
  web: { display: 'contents' },
});
