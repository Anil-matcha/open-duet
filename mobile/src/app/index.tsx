import { Link } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/lib/auth-context';
import { serverLabel } from '@/lib/server-url';

export default function Home() {
  const { state } = useAuth();
  const server = state.status === 'paired' ? serverLabel(state.server) : '';
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Paired</Text>
      <Text style={styles.body}>This phone is paired with {server}.</Text>
      <Text style={styles.body}>Conversations arrive in the next change.</Text>
      <Link href="/settings" style={styles.link}>
        Settings
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  title: { fontSize: 20, fontWeight: '600' },
  body: { fontSize: 16, textAlign: 'center' },
  link: { fontSize: 16, color: '#0a7ea4', paddingVertical: 8 },
});
