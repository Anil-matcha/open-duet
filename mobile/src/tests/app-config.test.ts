// The Android release build shrinks and renames code (R8). expo-camera's QR scanner then stops working without
// any error on screen (it logs "Failed to initialize BarcodeAnalyzer" and the camera never reports a code), and
// a keep rule that is too narrow crashes the app at launch. These rules are what a phone showed to work.
type Plugin = string | [string, Record<string, unknown>];

const config = jest.requireActual<{ expo: { plugins: Plugin[] } }>('../../app.json');

function androidOptions(): { extraProguardRules?: string } {
  const plugin = config.expo.plugins.find((entry): entry is [string, Record<string, unknown>] => Array.isArray(entry) && entry[0] === 'expo-build-properties');
  return ((plugin?.[1] ?? {}) as { android?: { extraProguardRules?: string } }).android ?? {};
}

describe('app.json', () => {
  it('keeps ML Kit out of the release build shrinking, so the QR scanner works', () => {
    const rules = androidOptions().extraProguardRules ?? '';
    expect(rules).toContain('-keep class com.google.mlkit.** { *; }');
    expect(rules).toContain('-keep class com.google.android.gms.internal.mlkit_** { *; }');
    expect(rules).toContain('-keep class com.google.firebase.components.** { *; }');
    expect(rules).toContain('-keep class * implements com.google.firebase.components.ComponentRegistrar { *; }');
  });
});
