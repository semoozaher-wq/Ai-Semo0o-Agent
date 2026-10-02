import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleProp,
  StyleSheet,
  View,
  ViewStyle,
} from 'react-native';
import { useTheme } from '../../theme';
import { Text } from './Text';
import { Icon, IconName } from './Icon';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'outline'
  | 'ghost'
  | 'danger'
  | 'success';

export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconRight?: IconName;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  icon,
  iconRight,
  loading = false,
  disabled = false,
  fullWidth = false,
  style,
}: ButtonProps) {
  const theme = useTheme();
  const isDisabled = disabled || loading;

  const height = size === 'sm' ? 36 : size === 'lg' ? 54 : 46;
  const padH = size === 'sm' ? theme.spacing.md : theme.spacing.xl;
  const fontSize = size === 'sm' ? theme.fontSize.sm : theme.fontSize.md;

  const bg: Record<ButtonVariant, string> = {
    primary: theme.colors.primary,
    secondary: theme.colors.surfaceMuted,
    outline: 'transparent',
    ghost: 'transparent',
    danger: theme.colors.danger,
    success: theme.colors.success,
  };

  const fg: Record<ButtonVariant, string> = {
    primary: theme.colors.onPrimary,
    secondary: theme.colors.text,
    outline: theme.colors.primary,
    ghost: theme.colors.textMuted,
    danger: '#FFFFFF',
    success: '#062A20',
  };

  return (
    <Pressable
      onPress={isDisabled ? undefined : onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.base,
        {
          height,
          paddingHorizontal: padH,
          borderRadius: theme.radius.pill,
          backgroundColor: bg[variant],
          borderWidth: variant === 'outline' ? 1 : 0,
          borderColor: theme.colors.primary,
          opacity: isDisabled ? 0.5 : pressed ? 0.85 : 1,
          alignSelf: fullWidth ? 'stretch' : 'flex-start',
        },
        style,
      ]}
    >
      <View style={styles.content}>
        {loading ? (
          <ActivityIndicator size="small" color={fg[variant]} />
        ) : icon ? (
          <Icon name={icon} size={size === 'sm' ? 16 : 18} color={fg[variant]} />
        ) : null}
        <Text
          weight="semibold"
          align="center"
          style={{ color: fg[variant], fontSize, marginHorizontal: 6 }}
        >
          {label}
        </Text>
        {iconRight && !loading ? (
          <Icon name={iconRight} size={size === 'sm' ? 16 : 18} color={fg[variant]} />
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { justifyContent: 'center', alignItems: 'center' },
  content: { flexDirection: 'row', alignItems: 'center' },
});
