import { DarkTheme, DefaultTheme, Link, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, useColorScheme, View } from 'react-native';
import { KeyboardProvider } from 'react-native-keyboard-controller';

import { PairingLinkHandler } from '@/components/pairing-link-handler';
import { AuthProvider, useAuth } from '@/lib/auth-context';
import { useTheme } from '@/lib/theme';

function SettingsLink() {
  const theme = useTheme();
  return (
    <Link href="/settings" style={{ color: theme.accentText }}>
      Settings
    </Link>
  );
}

function RoomsLink() {
  const theme = useTheme();
  return (
    <Link href="/rooms" style={{ color: theme.accentText }}>
      Rooms
    </Link>
  );
}

function RootStack() {
  const { state } = useAuth();
  const theme = useTheme();
  if (state.status === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.background }}>
        <ActivityIndicator />
      </View>
    );
  }
  const paired = state.status === 'paired';
  return (
    <Stack>
      <Stack.Protected guard={paired}>
        <Stack.Screen name="index" options={{ title: 'Conversations', headerLeft: RoomsLink, headerRight: SettingsLink }} />
        <Stack.Screen name="search" options={{ title: 'Search' }} />
        <Stack.Screen name="rooms/index" options={{ title: 'Rooms' }} />
        <Stack.Screen name="rooms/[id]" options={{ title: 'Room' }} />
        <Stack.Screen name="thread/[id]" options={{ title: 'Conversation' }} />
        <Stack.Screen name="new" options={{ title: 'New conversation', presentation: 'modal' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
      </Stack.Protected>
      <Stack.Protected guard={!paired}>
        <Stack.Screen name="pair" options={{ title: 'Pair with your server' }} />
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
  return (
    <KeyboardProvider>
      <ThemeProvider value={navigationTheme}>
        <AuthProvider>
          <StatusBar style="auto" />
          <PairingLinkHandler />
          <RootStack />
        </AuthProvider>
      </ThemeProvider>
    </KeyboardProvider>
  );
}
