import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleProp,
  StyleSheet,
  ViewStyle,
} from 'react-native';
import { useTheme } from '../../theme';
import { Icon, IconName, IconTone } from './Icon';

export type IconButtonVariant = 'ghost' | 'soft' | 'solid' | 'outline';
export type IconButtonSize = 'sm' | 'md' | 'lg';

export interface IconButtonProps {
  name: IconName;
  onPress?: (() => void) | undefined;
  variant?: IconButtonVariant | undefined;
  size?: IconButtonSize | undefined;
  tone?: IconTone | undefined;
  color?: string | undefined;
  loading?: boolean | undefined;
  disabled?: boolean | undefined;
  /** Renders a pill (default) or a rounded square. */
  shape?: 'circle' | 'square' | undefined;
  style?: StyleProp<ViewStyle> | undefined;
  accessibilityLabel?: string | undefined;
}

const SIZES: Record<IconButtonSize, number> = { sm: 34, md: 42, lg: 50 };
const ICON_SIZES: Record<IconButtonSize, number> = { sm: 17, md: 20, lg: 24 };

export function IconButton({
  name,
  onPress,
  variant = 'ghost',
  size = 'md',
  tone,
  color,
  loading = false,
  disabled = false,
  shape = 'circle',
  style,
  accessibilityLabel,
}: IconButtonProps) {
  const theme = useTheme();
  const dim = SIZES[size];
  const isDisabled = disabled || loading;

  const background: Record<IconButtonVariant, string> = {
    ghost: 'transparent',
    soft: theme.colors.surfaceMuted,
    solid: theme.colors.primary,
    outline: 'transparent',
  };

  const resolvedTone: IconTone | undefined =
    variant === 'solid' ? undefined : (tone ?? 'muted');
  const resolvedColor = variant === 'solid' ? theme.colors.onPrimary : color;

  return (
    <Pressable
      onPress={isDisabled ? undefined : onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        styles.base,
        {
          width: dim,
          height: dim,
          borderRadius: shape === 'circle' ? dim / 2 : theme.radius.md,
          backgroundColor: background[variant],
          borderWidth: variant === 'outline' ? 1 : 0,
          borderColor: theme.colors.border,
          opacity: isDisabled ? 0.45 : pressed ? 0.7 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator
          size="small"
          color={resolvedColor ?? theme.colors.text}
        />
      ) : (
        <Icon
          name={name}
          size={ICON_SIZES[size]}
          {...(resolvedColor !== undefined ? { color: resolvedColor } : {})}
          {...(resolvedTone !== undefined ? { tone: resolvedTone } : {})}
        />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center' },
});
