import { Geist_400Regular } from '@expo-google-fonts/geist/400Regular';
import { Geist_400Regular_Italic } from '@expo-google-fonts/geist/400Regular_Italic';
import { Geist_500Medium } from '@expo-google-fonts/geist/500Medium';
import { Geist_600SemiBold } from '@expo-google-fonts/geist/600SemiBold';
import { Geist_700Bold } from '@expo-google-fonts/geist/700Bold';
import { Geist_700Bold_Italic } from '@expo-google-fonts/geist/700Bold_Italic';
import { GeistMono_400Regular } from '@expo-google-fonts/geist-mono/400Regular';

// Only these seven files are bundled (about 90 KB each); importing the package root would bundle every weight.
// The keys are the names in `FAMILY` (`fonts.ts`).
export const FONT_FILES = {
  Geist_400Regular,
  Geist_400Regular_Italic,
  Geist_500Medium,
  Geist_600SemiBold,
  Geist_700Bold,
  Geist_700Bold_Italic,
  GeistMono_400Regular,
};
