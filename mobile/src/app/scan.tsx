import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { parsePairingLink } from '@/lib/pairing-link';

export default function Scan() {
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
        <Pressable accessibilityRole="button" onPress={() => router.back()}>
          <Text style={styles.link}>Type the code instead</Text>
        </Pressable>
      </View>
    );
  }

  const onScanned = ({ data }: { data: string }) => {
    if (handled.current) return;
    const link = parsePairingLink(data);
    if (!link) {
      setMessage('That is not an Open Dots pairing code.');
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

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16 },
  text: { fontSize: 16, textAlign: 'center' },
  button: { backgroundColor: '#0a7ea4', borderRadius: 8, paddingVertical: 12, paddingHorizontal: 20 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  link: { color: '#0a7ea4', fontSize: 16 },
  banner: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 20, backgroundColor: 'rgba(0,0,0,0.6)' },
  bannerText: { color: '#fff', fontSize: 15, textAlign: 'center' },
});
