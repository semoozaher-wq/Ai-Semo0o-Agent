/**
 * Typography assets — Tajawal for Arabic UI copy, Poppins for the Latin brand
 * wordmark. Loaded once at the app root (see `app/_layout.tsx`).
 */

export const FONT_ASSETS = {
  Tajawal_400Regular: require('../../assets/fonts/Tajawal-Regular.ttf'),
  Tajawal_500Medium: require('../../assets/fonts/Tajawal-Medium.ttf'),
  Tajawal_700Bold: require('../../assets/fonts/Tajawal-Bold.ttf'),
  Poppins_500Medium: require('../../assets/fonts/Poppins-Medium.ttf'),
  Poppins_600SemiBold: require('../../assets/fonts/Poppins-SemiBold.ttf'),
  Poppins_700Bold: require('../../assets/fonts/Poppins-Bold.ttf'),
} as const;

export type FontFamilyKey = keyof typeof FONT_ASSETS;

/** Map a design weight token to the loaded Arabic family. */
export const ARABIC_FAMILY: Record<string, FontFamilyKey> = {
  regular: 'Tajawal_400Regular',
  medium: 'Tajawal_500Medium',
  semibold: 'Tajawal_700Bold',
  bold: 'Tajawal_700Bold',
  extrabold: 'Tajawal_700Bold',
};

export const LATIN_FAMILY = {
  medium: 'Poppins_500Medium',
  semibold: 'Poppins_600SemiBold',
  bold: 'Poppins_700Bold',
} as const;
