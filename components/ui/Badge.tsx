import React from 'react';
import { StyleSheet, View, ViewStyle, StyleProp } from 'react-native';
import { ThemeColors, useTheme } from '../../theme';
import { Text } from './Text';

export type BadgeTone =
  | 'neutral'
  | 'primary'
  | 'accent'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info';

export interface BadgeProps {
  label: string;
  tone?: BadgeTone;
  style?: StyleProp<ViewStyle>;
}

const TONE_MAP: Record<
  BadgeTone,
  { fg: keyof ThemeColors; bg: keyof ThemeColors }
> = {
  neutral: { fg: 'textMuted', bg: 'surfaceMuted' },
  primary: { fg: 'primary', bg: 'primarySoft' },
  accent: { fg: 'accent', bg: 'accentSoft' },
  success: { fg: 'success', bg: 'successSoft' },
  warning: { fg: 'warning', bg: 'warningSoft' },
  danger: { fg: 'danger', bg: 'dangerSoft' },
  info: { fg: 'info', bg: 'infoSoft' },
};

export function Badge({ label, tone = 'neutral', style }: BadgeProps) {
  const theme = useTheme();
  const { fg, bg } = TONE_MAP[tone];
  return (
    <View
      style={[
        styles.base,
        {
          backgroundColor: theme.colors[bg],
          borderRadius: theme.radius.sm,
          paddingVertical: 3,
          paddingHorizontal: 8,
        },
        style,
      ]}
    >
      <Text
        weight="semibold"
        align="center"
        style={{ color: theme.colors[fg], fontSize: theme.fontSize['2xs'] }}
      >
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: { alignSelf: 'flex-start' },
});
