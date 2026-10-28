import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';

import { useAuth } from '@/lib/auth-context';
import { parsePairingLink } from '@/lib/pairing-link';

// A pairing link opened from outside (the phone camera, a message) fills in the pairing screen.
// It never connects by itself: the person still checks the server and taps Connect.
//
// Each link is handled once. The launch URL stays the same while the sign-in state changes, so without
// that, pairing from a link would be followed by an "Already paired" alert, and signing out later would
// fill the screen with the old, already used code again.
export function PairingLinkHandler() {
  const { state } = useAuth();
  const router = useRouter();
  const url = Linking.useLinkingURL();
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (!url || state.status === 'loading' || handled.current === url) return;
    const link = parsePairingLink(url);
    if (!link) return;
    handled.current = url;
    if (state.status === 'paired') {
      Alert.alert('Already paired', 'Sign out in Settings first if you want to pair with a different server.');
      return;
    }
    router.navigate({ pathname: '/pair', params: { server: link.server ?? '', code: link.code } });
  }, [url, state.status, router]);

  return null;
}
