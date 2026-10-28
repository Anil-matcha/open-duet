import { useContext, useEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';
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

// With the keyboard closed the app still draws behind the bottom system bar (navigation buttons or the
// gesture line), so the screen leaves that much room at the bottom. Reported on a Galaxy S23 Ultra, where the
// bottom of the message box was cut off. With the keyboard open, the keyboard covers that bar.
function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setOpen(true));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setOpen(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return open;
}

export function KeyboardScreen({ children }: { children: ReactNode }) {
  const outer = useRef<ComponentRef<typeof View>>(null);
  const [offset, setOffset] = useState(0);
  const insets = useContext(SafeAreaInsetsContext);
  const keyboardOpen = useKeyboardOpen();

  return (
    <View
      ref={outer}
      testID="keyboard-screen"
      style={[styles.flex, { paddingBottom: keyboardOpen ? 0 : (insets?.bottom ?? 0) }]}
      onLayout={() => outer.current?.measureInWindow?.((_x, y) => setOffset((current) => (Math.abs(current - y) < 1 ? current : y)))}>
      <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={keyboardOffset(offset, Platform.OS, insets?.bottom ?? 0)}>
        {children}
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 } });
