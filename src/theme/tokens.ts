/**
 * Design tokens — the single source of truth for the Semo0o AI visual language.
 * Values are intentionally framework-agnostic so they can be consumed by
 * React Native, react-native-web, and static previews alike.
 */

export const palette = {
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

export const gradients = {
  brand: ['#6C5CE7', '#00D2D3'] as const,
  brandReverse: ['#00D2D3', '#6C5CE7'] as const,
  aurora: ['#6C5CE7', '#FD79A8'] as const,
  ocean: ['#4DA3FF', '#00D2D3'] as const,
  sunset: ['#FD79A8', '#FFB020'] as const,
  midnight: ['#191A2E', '#0A0B14'] as const,
  surface: ['#1E2038', '#14162B'] as const,
} as const;

export type GradientName = keyof typeof gradients;
