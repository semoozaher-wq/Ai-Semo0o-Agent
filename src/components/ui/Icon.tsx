import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { ThemeColors, useTheme } from '../../theme';

export type IconName = keyof typeof Ionicons.glyphMap;

export type IconTone =
  | 'default'
  | 'muted'
  | 'subtle'
  | 'primary'
  | 'accent'
  | 'highlight'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'inverse';

export interface IconProps {
  name: IconName;
  size?: number | undefined;
  color?: string | undefined;
  tone?: IconTone | undefined;
}

const TONE_KEYS: Record<IconTone, keyof ThemeColors> = {
  default: 'text',
  muted: 'textMuted',
  subtle: 'textSubtle',
  primary: 'primary',
  accent: 'accent',
  highlight: 'highlight',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  info: 'info',
  inverse: 'textInverse',
};

export function Icon({ name, size = 20, color, tone }: IconProps) {
  const theme = useTheme();
  const resolved =
    color ?? (tone ? (theme.colors[TONE_KEYS[tone]] as string) : theme.colors.text);
  return <Ionicons name={name} size={size} color={resolved} />;
}
