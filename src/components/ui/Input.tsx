import React from 'react';
import {
  StyleProp,
  StyleSheet,
  TextInput,
  TextInputProps,
  View,
  ViewStyle,
} from 'react-native';
import { useTheme } from '../../theme';
import { Text } from './Text';
import { Icon, IconName } from './Icon';

export interface InputProps extends TextInputProps {
  label?: string;
  icon?: IconName;
  error?: string;
  hint?: string;
  /** Optional trailing accessory (e.g. a password visibility toggle). */
  right?: React.ReactNode;
  containerStyle?: StyleProp<ViewStyle>;
}

export function Input({
  label,
  icon,
  error,
  hint,
  right,
  containerStyle,
  style,
  ...rest
}: InputProps) {
  const theme = useTheme();
  const [focused, setFocused] = React.useState(false);

  return (
    <View style={containerStyle}>
      {label ? (
        <Text variant="label" tone="muted" style={{ marginBottom: 6 }}>
          {label}
        </Text>
      ) : null}
      <View
        style={[
          styles.field,
          {
            backgroundColor: theme.colors.surfaceMuted,
            borderRadius: theme.radius.lg,
            borderWidth: 1,
            borderColor: error
              ? theme.colors.danger
              : focused
                ? theme.colors.primary
                : theme.colors.border,
            paddingHorizontal: theme.spacing.md,
          },
        ]}
      >
        {icon ? (
          <View style={{ marginEnd: theme.spacing.sm }}>
            <Icon name={icon} size={18} tone={focused ? 'primary' : 'subtle'} />
          </View>
        ) : null}
        <TextInput
          {...rest}
          onFocus={(e) => {
            setFocused(true);
            rest.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            rest.onBlur?.(e);
          }}
          placeholderTextColor={theme.colors.textSubtle}
          style={[
            {
              flex: 1,
              color: theme.colors.text,
              fontSize: theme.fontSize.md,
              paddingVertical: 12,
              textAlign: 'right',
            },
            style,
          ]}
        />
        {right ? <View style={{ marginStart: theme.spacing.sm }}>{right}</View> : null}
      </View>
      {error ? (
        <Text variant="caption" tone="danger" style={{ marginTop: 4 }}>
          {error}
        </Text>
      ) : hint ? (
        <Text variant="caption" tone="subtle" style={{ marginTop: 4 }}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { flexDirection: 'row', alignItems: 'center' },
});
