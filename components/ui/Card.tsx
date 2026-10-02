import React from 'react';
import {
  Pressable,
  StyleProp,
  StyleSheet,
  View,
  ViewStyle,
} from 'react-native';
import { GradientName, useTheme } from '../../theme';
import { Gradient } from './Gradient';

export interface CardProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  padded?: boolean;
  onPress?: () => void;
  gradient?: GradientName;
  accent?: string;
  bordered?: boolean;
}

export function Card({
  children,
  style,
  padded = true,
  onPress,
  gradient,
  accent,
  bordered = true,
}: CardProps) {
  const theme = useTheme();

  const base: StyleProp<ViewStyle> = [
    styles.card,
    {
      borderRadius: theme.radius.xl,
      padding: padded ? theme.spacing.lg : 0,
      borderWidth: bordered ? StyleSheet.hairlineWidth : 0,
      borderColor: accent ?? theme.colors.border,
    },
    !gradient && {
      backgroundColor: theme.colors.surface,
    },
    style,
  ];

  const inner = gradient ? (
    <Gradient name={gradient} radius={theme.radius.xl} style={styles.fill}>
      <View style={[base, { backgroundColor: 'transparent' }]}>{children}</View>
    </Gradient>
  ) : (
    <View style={base}>{children}</View>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [{ opacity: pressed ? 0.85 : 1 }]}
      >
        {inner}
      </Pressable>
    );
  }

  return inner;
}

const styles = StyleSheet.create({
  card: { overflow: 'hidden' },
  fill: { width: '100%' },
});
