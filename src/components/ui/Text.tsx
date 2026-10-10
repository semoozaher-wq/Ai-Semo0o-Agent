import React from 'react';
import { Text as RNText, TextProps as RNTextProps } from 'react-native';
import { ThemeColors, useTheme } from '../../theme';
import { ARABIC_FAMILY } from '../../theme/fonts';

export type TextVariant =
  | 'display'
  | 'title'
  | 'subtitle'
  | 'body'
  | 'label'
  | 'caption';

export type TextTone =
  | 'default'
  | 'muted'
  | 'subtle'
  | 'primary'
  | 'accent'
  | 'highlight'
  | 'success'
  | 'warning'
  | 'danger'
  | 'inverse';

export type TextWeight = 'regular' | 'medium' | 'semibold' | 'bold' | 'extrabold';

export interface TextProps extends RNTextProps {
  variant?: TextVariant;
  tone?: TextTone;
  weight?: TextWeight;
  align?: 'auto' | 'left' | 'right' | 'center';
  children?: React.ReactNode;
}

const TONE_KEYS: Record<TextTone, keyof ThemeColors> = {
  default: 'text',
  muted: 'textMuted',
  subtle: 'textSubtle',
  primary: 'primary',
  accent: 'accent',
  highlight: 'highlight',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  inverse: 'textInverse',
};

export function Text({
  variant = 'body',
  tone = 'default',
  weight,
  align = 'right',
  style,
  children,
  ...rest
}: TextProps) {
  const theme = useTheme();

  const sizeFor: Record<TextVariant, number> = {
    display: theme.fontSize['4xl'],
    title: theme.fontSize['2xl'],
    subtitle: theme.fontSize.lg,
    body: theme.fontSize.md,
    label: theme.fontSize.sm,
    caption: theme.fontSize.xs,
  };

  const weightFor: Record<TextVariant, TextWeight> = {
    display: 'extrabold',
    title: 'bold',
    subtitle: 'semibold',
    body: 'regular',
    label: 'semibold',
    caption: 'medium',
  };

  const resolvedWeight = weight ?? weightFor[variant];
  const family = ARABIC_FAMILY[resolvedWeight] ?? ARABIC_FAMILY.regular;

  return (
    <RNText
      {...rest}
      style={[
        {
          color: theme.colors[TONE_KEYS[tone]],
          fontSize: sizeFor[variant],
          fontFamily: family,
          // The loaded family already encodes its weight; a numeric weight on
          // top of a single-face family would trigger faux-bold on web.
          fontWeight: 'normal',
          textAlign: align,
          lineHeight: Math.round(sizeFor[variant] * theme.lineHeight.normal),
        },
        style,
      ]}
    >
      {children}
    </RNText>
  );
}
