import { useContext, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

// Keeps the bottom of a screen above the on-screen keyboard on iOS and Android.
//
// Android emulator, Expo Go: with no behavior set the keyboard covered the composer; with "padding" and
// the measured offset it moved up but its bottom edge stayed about 24 dp behind the keyboard, which is
// the height of the bottom system bar. Probably the keyboard height Android reports leaves that bar out
// while the app draws edge to edge, so on Android the offset is lowered by the bottom inset, which adds
// that much padding. The cause is a guess from that one observation.
//
// The offset is where this screen starts in the window (status bar and header above it), measured rather
// than guessed, because KeyboardAvoidingView counts from its own top edge.
export function keyboardOffset(measuredTop: number, os: string, bottomInset: number): number {
  return os === 'android' ? measuredTop - bottomInset : measuredTop;
}

export function KeyboardScreen({ children }: { children: ReactNode }) {
  const outer = useRef<ComponentRef<typeof View>>(null);
  const [offset, setOffset] = useState(0);
  const insets = useContext(SafeAreaInsetsContext);

  return (
    <View
      ref={outer}
      style={styles.flex}
      onLayout={() => outer.current?.measureInWindow?.((_x, y) => setOffset((current) => (Math.abs(current - y) < 1 ? current : y)))}>
      <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={keyboardOffset(offset, Platform.OS, insets?.bottom ?? 0)}>
        {children}
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 } });
