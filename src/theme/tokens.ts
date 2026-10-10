/**
 * Design tokens — the single source of truth for the Semo0o AI visual language.
 * Values are intentionally framework-agnostic so they can be consumed by
 * React Native, react-native-web, and static previews alike.
 */

export const palette = {
  // Deep navy canvas — the Semo0o "space" background (reference design)
  navy50: '#EEF1FF',
  navy100: '#DDE3FF',
  navy200: '#B9C6FF',
  navy300: '#8FA3FF',
  navy400: '#5B6FD6',
  navy500: '#2A3A7A',
  navy600: '#1B2757',
  navy700: '#131C42',
  navy800: '#0C1230',
  navy900: '#080C22',
  navy950: '#050818',

  // Brand — violet/indigo core
  indigo50: '#EEF0FF',
  indigo100: '#DDE1FF',
  indigo200: '#BFC6FF',
  indigo300: '#9AA4FF',
  indigo400: '#7B84FF',
  indigo500: '#6C5CE7',
  indigo600: '#5A49D6',
  indigo700: '#4638B0',
  indigo800: '#332A85',
  indigo900: '#241E5E',

  // Accent — cyan
  cyan300: '#7DF3F0',
  cyan400: '#3FE0DE',
  cyan500: '#00D2D3',
  cyan600: '#00B4B6',

  // Accent — pink
  pink400: '#FF9BC1',
  pink500: '#FD79A8',
  pink600: '#E85D8C',

  // Accent — amber
  amber400: '#FFC46B',
  amber500: '#FFB020',

  // Neutrals — deep space
  slate0: '#FFFFFF',
  slate50: '#F6F7FB',
  slate100: '#EDEFF7',
  slate200: '#D9DCEA',
  slate300: '#B7BBD0',
  slate400: '#8A8DA8',
  slate500: '#5E6280',
  slate600: '#414463',
  slate700: '#2A2C45',
  slate800: '#191A2E',
  slate900: '#0F1020',
  slate950: '#0A0B14',

  // Semantic
  success: '#2BD9A0',
  successSoft: '#123B31',
  warning: '#FFB020',
  warningSoft: '#3D2E10',
  danger: '#FF6B6B',
  dangerSoft: '#3D1A1E',
  info: '#4DA3FF',
  infoSoft: '#12293D',
} as const;

export const spacing = {
  none: 0,
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 24,
  '3xl': 32,
  '4xl': 40,
  '5xl': 56,
} as const;

export const radius = {
  none: 0,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 24,
  '3xl': 32,
  pill: 999,
} as const;

export const fontSize = {
  '2xs': 10,
  xs: 11,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 20,
  '2xl': 24,
  '3xl': 30,
  '4xl': 38,
  '5xl': 48,
} as const;

export const fontWeight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
  extrabold: '800',
} as const;

export const lineHeight = {
  tight: 1.2,
  snug: 1.35,
  normal: 1.5,
  relaxed: 1.7,
} as const;

/**
 * Elevation scale. Exposed as plain data plus a `shadow()` helper so both
 * native (elevation / shadow*) and web (box-shadow) render consistently.
 */
export const elevation = {
  none: 0,
  xs: 1,
  sm: 2,
  md: 4,
  lg: 8,
  xl: 16,
  '2xl': 24,
} as const;

export type ElevationLevel = keyof typeof elevation;

const SHADOW_MAP: Record<
  ElevationLevel,
  { opacity: number; radius: number; y: number; e: number }
> = {
  none: { opacity: 0, radius: 0, y: 0, e: 0 },
  xs: { opacity: 0.12, radius: 2, y: 1, e: 1 },
  sm: { opacity: 0.16, radius: 6, y: 2, e: 2 },
  md: { opacity: 0.2, radius: 12, y: 4, e: 4 },
  lg: { opacity: 0.24, radius: 20, y: 8, e: 8 },
  xl: { opacity: 0.3, radius: 30, y: 14, e: 16 },
  '2xl': { opacity: 0.36, radius: 44, y: 20, e: 24 },
};

export interface ShadowStyle {
  shadowColor: string;
  shadowOffset: { width: number; height: number };
  shadowOpacity: number;
  shadowRadius: number;
  elevation: number;
}

/** Build a cross-platform shadow style for a given elevation level. */
export function shadow(level: ElevationLevel, color = '#05060F'): ShadowStyle {
  const v = SHADOW_MAP[level];
  return {
    shadowColor: color,
    shadowOffset: { width: 0, height: v.y },
    shadowOpacity: v.opacity,
    shadowRadius: v.radius,
    elevation: v.e,
  };
}

/** Motion tokens — durations (ms) and easing curves. */
export const motion = {
  duration: {
    instant: 90,
    fast: 160,
    normal: 240,
    slow: 360,
    slower: 520,
  },
  easing: {
    standard: 'cubic-bezier(0.2, 0, 0, 1)',
    decelerate: 'cubic-bezier(0, 0, 0, 1)',
    accelerate: 'cubic-bezier(0.3, 0, 1, 1)',
  },
} as const;

/** Blur radii for glass surfaces (web backdrop-filter / native blur). */
export const blur = {
  none: 0,
  sm: 8,
  md: 16,
  lg: 28,
  xl: 40,
} as const;

export const gradients = {
  brand: ['#6C5CE7', '#00D2D3'] as const,
  brandReverse: ['#00D2D3', '#6C5CE7'] as const,
  aurora: ['#6C5CE7', '#FD79A8'] as const,
  ocean: ['#4DA3FF', '#00D2D3'] as const,
  sunset: ['#FD79A8', '#FFB020'] as const,
  midnight: ['#191A2E', '#0A0B14'] as const,
  surface: ['#1E2038', '#14162B'] as const,
  // Redesign additions
  nebula: ['#241E5E', '#6C5CE7', '#00D2D3'] as const,
  dawn: ['#FF9BC1', '#FFC46B'] as const,
  graphite: ['#2A2C45', '#14162B'] as const,
  // Side rail tint — a subtle navy wash for the navigation column.
  rail: ['#0B1130', '#080C22'] as const,
  // Soft brand glow used behind the hero mark.
  glow: ['#7C5CFA', '#22D3EE'] as const,
} as const;

export type GradientName = keyof typeof gradients;
