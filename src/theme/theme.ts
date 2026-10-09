import {
  palette,
  spacing,
  radius,
  fontSize,
  fontWeight,
  lineHeight,
  gradients,
  elevation,
  motion,
  blur,
} from './tokens';

export type ThemeMode = 'light' | 'dark';

export interface ThemeColors {
  /** App canvas background */
  background: string;
  /** Slightly raised background (e.g. app bar) */
  backgroundElevated: string;
  /** Card / panel surface */
  surface: string;
  /** Raised surface (modals, popovers) */
  surfaceElevated: string;
  /** Muted surface for chips / inline blocks */
  surfaceMuted: string;
  /** Hover / pressed surface tint */
  surfaceHover: string;
  /** Hairline borders */
  border: string;
  /** Stronger border for emphasis */
  borderStrong: string;
  /** Scrim behind modals */
  overlay: string;
  /** Modal / drawer scrim */
  scrim: string;

  /** Translucent glass surface (over imagery / gradients) */
  glass: string;
  /** Glass hairline border */
  glassBorder: string;

  /** Primary text */
  text: string;
  /** Secondary text */
  textMuted: string;
  /** Tertiary / captions */
  textSubtle: string;
  /** Text on colored surfaces */
  textInverse: string;

  /** Brand primary */
  primary: string;
  /** Tinted primary surface */
  primarySoft: string;
  /** Text/icon on primary */
  onPrimary: string;

  /** Cyan accent */
  accent: string;
  accentSoft: string;

  /** Pink accent */
  highlight: string;
  highlightSoft: string;

  success: string;
  successSoft: string;
  warning: string;
  warningSoft: string;
  danger: string;
  dangerSoft: string;
  info: string;
  infoSoft: string;

  /** Shadow tint used by the elevation helper */
  shadow: string;
  /** Focus ring colour for keyboard / accessibility */
  focusRing: string;
}

export interface Theme {
  mode: ThemeMode;
  colors: ThemeColors;
  spacing: typeof spacing;
  radius: typeof radius;
  fontSize: typeof fontSize;
  fontWeight: typeof fontWeight;
  lineHeight: typeof lineHeight;
  gradients: typeof gradients;
  elevation: typeof elevation;
  motion: typeof motion;
  blur: typeof blur;
}

const darkColors: ThemeColors = {
  background: palette.slate950,
  backgroundElevated: palette.slate900,
  surface: '#14162B',
  surfaceElevated: '#1B1D36',
  surfaceMuted: '#20223D',
  surfaceHover: '#262845',
  border: 'rgba(255,255,255,0.08)',
  borderStrong: 'rgba(255,255,255,0.16)',
  overlay: 'rgba(4,5,12,0.72)',
  scrim: 'rgba(4,5,12,0.62)',

  glass: 'rgba(27,29,54,0.66)',
  glassBorder: 'rgba(255,255,255,0.12)',

  text: '#F2F3FA',
  textMuted: '#A9ADC9',
  textSubtle: '#71748F',
  textInverse: '#0A0B14',

  primary: palette.indigo500,
  primarySoft: 'rgba(108,92,231,0.16)',
  onPrimary: '#FFFFFF',

  accent: palette.cyan500,
  accentSoft: 'rgba(0,210,211,0.14)',

  highlight: palette.pink500,
  highlightSoft: 'rgba(253,121,168,0.16)',

  success: palette.success,
  successSoft: palette.successSoft,
  warning: palette.warning,
  warningSoft: palette.warningSoft,
  danger: palette.danger,
  dangerSoft: palette.dangerSoft,
  info: palette.info,
  infoSoft: palette.infoSoft,

  shadow: '#05060F',
  focusRing: 'rgba(123,132,255,0.55)',
};

const lightColors: ThemeColors = {
  background: '#F4F5FB',
  backgroundElevated: '#FFFFFF',
  surface: '#FFFFFF',
  surfaceElevated: '#FFFFFF',
  surfaceMuted: '#EEF0F8',
  surfaceHover: '#E7EAF6',
  border: 'rgba(16,18,40,0.08)',
  borderStrong: 'rgba(16,18,40,0.16)',
  overlay: 'rgba(16,18,40,0.4)',
  scrim: 'rgba(16,18,40,0.34)',

  glass: 'rgba(255,255,255,0.72)',
  glassBorder: 'rgba(16,18,40,0.08)',

  text: '#14162B',
  textMuted: '#5E6280',
  textSubtle: '#8A8DA8',
  textInverse: '#FFFFFF',

  primary: palette.indigo600,
  primarySoft: 'rgba(90,73,214,0.10)',
  onPrimary: '#FFFFFF',

  accent: palette.cyan600,
  accentSoft: 'rgba(0,180,182,0.12)',

  highlight: palette.pink600,
  highlightSoft: 'rgba(232,93,140,0.12)',

  success: '#0FA97A',
  successSoft: '#E2F8F0',
  warning: '#B87A00',
  warningSoft: '#FFF3DC',
  danger: '#D64545',
  dangerSoft: '#FDE7E7',
  info: '#2E7DD1',
  infoSoft: '#E3F0FC',

  shadow: '#1A1C33',
  focusRing: 'rgba(90,73,214,0.45)',
};

export const darkTheme: Theme = {
  mode: 'dark',
  colors: darkColors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  lineHeight,
  gradients,
  elevation,
  motion,
  blur,
};

export const lightTheme: Theme = {
  mode: 'light',
  colors: lightColors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  lineHeight,
  gradients,
  elevation,
  motion,
  blur,
};

export const themes: Record<ThemeMode, Theme> = {
  dark: darkTheme,
  light: lightTheme,
};
