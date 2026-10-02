import React from 'react';
import { Pressable, StyleSheet, View, ViewStyle, StyleProp } from 'react-native';
import { useTheme } from '../../theme';
import { Text } from './Text';
import { Icon, IconName } from './Icon';

export type ChipTone = 'default' | 'primary' | 'accent' | 'highlight';

export interface ChipProps {
  label: string;
  icon?: IconName;
  selected?: boolean;
  onPress?: () => void;
  tone?: ChipTone;
  size?: 'sm' | 'md';
  style?: StyleProp<ViewStyle>;
}

export function Chip({
  label,
  icon,
  selected = false,
  onPress,
  tone = 'primary',
  size = 'md',
  style,
}: ChipProps) {
  const theme = useTheme();

  const toneColor: Record<ChipTone, string> = {
    default: theme.colors.textMuted,
    primary: theme.colors.primary,
    accent: theme.colors.accent,
    highlight: theme.colors.highlight,
  };
  const soft: Record<ChipTone, string> = {
    default: theme.colors.surfaceMuted,
    primary: theme.colors.primarySoft,
    accent: theme.colors.accentSoft,
    highlight: theme.colors.highlightSoft,
  };

  const color = toneColor[tone];
  const background = selected ? color : soft[tone];
  const fg = selected ? theme.colors.onPrimary : color;

  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [
        styles.base,
        {
          backgroundColor: background,
          borderRadius: theme.radius.pill,
          paddingVertical: size === 'sm' ? 5 : 8,
          paddingHorizontal: size === 'sm' ? theme.spacing.sm : theme.spacing.md,
          borderWidth: selected ? 0 : StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
          opacity: pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {icon ? (
        <View style={{ marginEnd: 6 }}>
          <Icon name={icon} size={size === 'sm' ? 13 : 15} color={fg} />
        </View>
      ) : null}
      <Text
        weight="semibold"
        align="center"
        style={{ color: fg, fontSize: size === 'sm' ? theme.fontSize.xs : theme.fontSize.sm }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start' },
});
