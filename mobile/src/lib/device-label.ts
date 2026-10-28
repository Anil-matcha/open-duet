import * as Device from 'expo-device';

/** The name this phone gives itself when pairing; it shows in the server's Settings → Devices. */
export function deviceLabel(): string {
  const name = (Device.deviceName ?? Device.modelName ?? '').trim();
  return (name || 'Phone').slice(0, 80);
}
