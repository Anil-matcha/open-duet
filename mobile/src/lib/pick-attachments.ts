// The two system pickers. Photos use the system photo picker, which needs no storage permission; files
// use the system document picker. Neither asks for the camera or microphone.

import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';

export type Picked = { name: string; mime: string; size: number | undefined; read: () => Promise<Uint8Array> };

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

const readFile = (uri: string) => async () => new Uint8Array(await new File(uri).arrayBuffer());

export async function pickPhotos(limit: number): Promise<Picked[]> {
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: limit > 1, selectionLimit: limit });
  if (result.canceled) return [];
  return result.assets.map((asset, index) => {
    const mime = asset.mimeType ?? 'image/jpeg';
    return {
      name: asset.fileName || `photo-${index + 1}.${EXTENSIONS[mime] ?? 'jpg'}`,
      mime,
      size: asset.fileSize,
      read: readFile(asset.uri),
    };
  });
}

export async function pickFiles(limit: number): Promise<Picked[]> {
  const result = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: limit > 1, copyToCacheDirectory: true });
  if (result.canceled) return [];
  return result.assets.slice(0, limit).map((asset) => ({
    name: asset.name,
    mime: asset.mimeType ?? 'application/octet-stream',
    size: asset.size,
    read: readFile(asset.uri),
  }));
}
