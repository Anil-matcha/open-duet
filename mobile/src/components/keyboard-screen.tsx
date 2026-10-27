import { useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { KeyboardAvoidingView, StyleSheet, View } from 'react-native';

// Keeps the bottom of a screen above the on-screen keyboard on iOS and Android. On an Android emulator
// the keyboard covered the composer with no behavior set (probably because the app draws edge to edge and
// the window is not shrunk), so "padding" is used on both platforms. The offset is where this screen
// starts in the window (status bar and header above it), measured rather than guessed, because
// KeyboardAvoidingView counts from its own top edge.
export function KeyboardScreen({ children }: { children: ReactNode }) {
  const outer = useRef<ComponentRef<typeof View>>(null);
  const [offset, setOffset] = useState(0);

  return (
    <View
      ref={outer}
      style={styles.flex}
      onLayout={() => outer.current?.measureInWindow?.((_x, y) => setOffset((current) => (Math.abs(current - y) < 1 ? current : y)))}>
      <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={offset}>
        {children}
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 } });
