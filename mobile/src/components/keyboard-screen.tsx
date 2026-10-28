import { useContext, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { KeyboardAvoidingView, useKeyboardState } from 'react-native-keyboard-controller';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

// Keeps the bottom of a screen above the on-screen keyboard on iOS and Android.
//
// The built Android app draws edge to edge, and the keyboard height that React Native's own
// KeyboardAvoidingView is given does not match that layout: on a Galaxy S23 Ultra the message box stayed
// behind the keyboard. react-native-keyboard-controller (the version Expo bundles) reads the keyboard
// from the window insets instead, so it follows what is really on screen. Not yet seen on a phone.
// automaticOffset measures the view in window coordinates, including the stack header; parent-relative
// layout coordinates otherwise underestimate the overlap and leave the composer behind the keyboard.
//
// With the keyboard closed the screen leaves room for the bottom system bar (navigation buttons or the
// gesture line), which the app also draws behind. With it open, the keyboard covers that bar.
export function KeyboardScreen({ children }: { children: ReactNode }) {
  const insets = useContext(SafeAreaInsetsContext);
  const keyboardOpen = useKeyboardState((state) => state.isVisible);
  return (
    <View style={[styles.flex, { paddingBottom: keyboardOpen ? 0 : (insets?.bottom ?? 0) }]} testID="keyboard-screen">
      <KeyboardAvoidingView style={styles.flex} behavior="padding" automaticOffset>
        {children}
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 } });
