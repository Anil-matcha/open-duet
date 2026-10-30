import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/text';
import { parsePairingLink } from '@/lib/pairing-link';
import { radius, touch, useStyles, type Palette } from '@/lib/theme';

export default function Scan() {
  const styles = useStyles(createStyles);
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [message, setMessage] = useState<string | null>(null);
  const handled = useRef(false);

  if (!permission) return <View style={styles.center} />;

  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.text}>The camera is used only to read the pairing QR code on your server’s screen.</Text>
        <Pressable accessibilityRole="button" style={styles.button} onPress={requestPermission}>
          <Text style={styles.buttonText}>Allow camera</Text>
        </Pressable>
        <Pressable accessibilityRole="button" hitSlop={16} onPress={() => router.back()}>
          <Text style={styles.link}>Type the code instead</Text>
        </Pressable>
      </View>
    );
  }

  const onScanned = ({ data }: { data: string }) => {
    if (handled.current) return;
    const link = parsePairingLink(data);
    if (!link) {
      setMessage('That is not a Suparagent pairing code.');
      return;
    }
    handled.current = true;
    router.dismissTo({ pathname: '/pair', params: { server: link.server ?? '', code: link.code } });
  };

  return (
    <View style={styles.fill}>
      <CameraView style={styles.fill} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={onScanned} />
      <View style={styles.banner}>
        <Text style={styles.bannerText}>{message ?? 'Point the camera at the app QR code in Settings → Devices.'}</Text>
      </View>
    </View>
  );
}

const createStyles = (p: Palette) =>
  StyleSheet.create({
    fill: { flex: 1 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16 },
    text: { fontSize: 16, textAlign: 'center', color: p.text },
    button: { minHeight: touch.min, justifyContent: 'center', backgroundColor: p.accent, borderRadius: radius.field, paddingHorizontal: 20 },
    buttonText: { color: p.onAccent, fontSize: 16, fontWeight: '600' },
    link: { color: p.accentText, fontSize: 16 },
    // Over the camera picture, so it does not follow the look.
    banner: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 20, backgroundColor: 'rgba(0,0,0,0.6)' },
    bannerText: { color: '#fff', fontSize: 15, textAlign: 'center' },
  });
