import { Link, Stack, useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { ActivityIndicator, Alert, View } from 'react-native';

import { AuthProvider, useAuth } from '@/lib/auth-context';
import { parsePairingLink } from '@/lib/pairing-link';

// A pairing link opened from outside (the phone camera, a message) fills in the pairing screen.
// It never connects by itself: the person still checks the server and taps Connect.
function PairingLinkHandler() {
  const { state } = useAuth();
  const router = useRouter();
  const url = Linking.useLinkingURL();

  useEffect(() => {
    if (!url || state.status === 'loading') return;
    const link = parsePairingLink(url);
    if (!link) return;
    if (state.status === 'paired') {
      Alert.alert('Already paired', 'Sign out in Settings first if you want to pair with a different server.');
      return;
    }
    router.navigate({ pathname: '/pair', params: { server: link.server ?? '', code: link.code } });
  }, [url, state.status, router]);

  return null;
}

function SettingsLink() {
  return <Link href="/settings">Settings</Link>;
}

function RootStack() {
  const { state } = useAuth();
  if (state.status === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }
  const paired = state.status === 'paired';
  return (
    <Stack>
      <Stack.Protected guard={paired}>
        <Stack.Screen name="index" options={{ title: 'Conversations', headerRight: SettingsLink }} />
        <Stack.Screen name="thread/[id]" options={{ title: 'Conversation' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
      </Stack.Protected>
      <Stack.Protected guard={!paired}>
        <Stack.Screen name="pair" options={{ title: 'Pair with your server' }} />
        <Stack.Screen name="scan" options={{ title: 'Scan QR code', presentation: 'modal' }} />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <StatusBar style="auto" />
      <PairingLinkHandler />
      <RootStack />
    </AuthProvider>
  );
}
