import { Link, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, View } from 'react-native';

import { PairingLinkHandler } from '@/components/pairing-link-handler';
import { AuthProvider, useAuth } from '@/lib/auth-context';

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
