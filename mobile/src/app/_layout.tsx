import { useFonts } from 'expo-font';
import { DarkTheme, DefaultTheme, Link, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, Pressable, useColorScheme, View } from 'react-native';
import { KeyboardProvider } from 'react-native-keyboard-controller';

import { PairingLinkHandler } from '@/components/pairing-link-handler';
import { FontsLoadedContext, Text, useFont } from '@/components/text';
import { AuthProvider, useAuth } from '@/lib/auth-context';
import { FONT_FILES } from '@/lib/font-assets';
import { touch, useTheme } from '@/lib/theme';

// A header link is a full-size touch target around its words, with room on the side facing the title.
function HeaderLink({ href, label, side }: { href: '/settings' | '/rooms'; label: string; side: 'left' | 'right' }) {
  const theme = useTheme();
  return (
    <Link href={href} asChild>
      <Pressable accessibilityRole="link" hitSlop={8} style={{ minHeight: touch.min, minWidth: touch.min, justifyContent: 'center', alignItems: side === 'left' ? 'flex-start' : 'flex-end', ...(side === 'left' ? { marginRight: 16 } : {}) }}>
        {/* Header text grows with the person's text size, but only so far: the title beside it needs room. */}
        <Text maxFontSizeMultiplier={1.3} style={{ color: theme.accentText, fontWeight: '500', fontSize: 16 }}>
          {label}
        </Text>
      </Pressable>
    </Link>
  );
}

const SettingsLink = () => <HeaderLink href="/settings" label="Settings" side="right" />;
const RoomsLink = () => <HeaderLink href="/rooms" label="Rooms" side="left" />;

function RootStack({ ready }: { ready: boolean }) {
  const { state } = useAuth();
  const theme = useTheme();
  const headerTitleStyle = useFont({ fontWeight: '600' });
  if (state.status === 'loading' || !ready) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.background }}>
        <ActivityIndicator />
      </View>
    );
  }
  const paired = state.status === 'paired';
  return (
    <Stack screenOptions={{ headerTitleStyle }}>
      <Stack.Protected guard={paired}>
        <Stack.Screen name="index" options={{ title: 'Conversations', headerLeft: RoomsLink, headerRight: SettingsLink }} />
        <Stack.Screen name="search" options={{ title: 'Search' }} />
        <Stack.Screen name="rooms/index" options={{ title: 'Rooms' }} />
        <Stack.Screen name="rooms/[id]" options={{ title: 'Room' }} />
        <Stack.Screen name="thread/[id]" options={{ title: 'Conversation' }} />
        <Stack.Screen name="files/[id]/index" options={{ title: 'Files' }} />
        <Stack.Screen name="files/[id]/view" options={{ title: 'File' }} />
        <Stack.Screen name="new" options={{ title: 'New conversation', presentation: 'modal' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
      </Stack.Protected>
      <Stack.Protected guard={!paired}>
        <Stack.Screen name="pair" options={{ title: 'Suparagent' }} />
        <Stack.Screen name="scan" options={{ title: 'Scan QR code', presentation: 'modal' }} />
      </Stack.Protected>
    </Stack>
  );
}

// Headers, screen backgrounds and borders come from the same palette as the screens themselves.
function useNavigationTheme() {
  const theme = useTheme();
  const base = useColorScheme() === 'dark' ? DarkTheme : DefaultTheme;
  return { ...base, colors: { ...base.colors, background: theme.background, card: theme.background, text: theme.text, border: theme.border, primary: theme.accentText } };
}

export default function RootLayout() {
  const navigationTheme = useNavigationTheme();
  // The screens wait for the fonts; if they cannot load, the app carries on in the system font.
  const [loaded, failed] = useFonts(FONT_FILES);
  return (
    <KeyboardProvider>
      <ThemeProvider value={navigationTheme}>
        <FontsLoadedContext.Provider value={loaded}>
          <AuthProvider>
            <StatusBar style="auto" />
            <PairingLinkHandler />
            <RootStack ready={loaded || failed !== null} />
          </AuthProvider>
        </FontsLoadedContext.Provider>
      </ThemeProvider>
    </KeyboardProvider>
  );
}
