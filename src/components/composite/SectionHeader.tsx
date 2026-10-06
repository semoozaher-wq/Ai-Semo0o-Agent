import React from 'react';
import { Pressable, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { useTheme } from '../../theme';
import { Text } from '../ui/Text';
import { Icon, IconName } from '../ui/Icon';

export interface SectionHeaderProps {
  title: string;
  subtitle?: string | undefined;
  actionLabel?: string | undefined;
  onAction?: (() => void) | undefined;
  icon?: IconName | undefined;
  style?: StyleProp<ViewStyle> | undefined;
}

export function SectionHeader({
  title,
  subtitle,
  actionLabel,
  onAction,
  icon,
  style,
}: SectionHeaderProps) {
  const theme = useTheme();
  return (
    <View style={[styles.row, { marginBottom: theme.spacing.md }, style]}>
      <View style={styles.left}>
        {icon ? (
          <View style={{ marginEnd: 8 }}>
            <Icon name={icon} size={18} tone="primary" />
          </View>
        ) : null}
        <View>
          <Text variant="subtitle" weight="bold">
            {title}
          </Text>
          {subtitle ? (
            <Text variant="caption" tone="subtle" style={{ marginTop: 2 }}>
              {subtitle}
            </Text>
          ) : null}
        </View>
      </View>
      {actionLabel && onAction ? (
        <Pressable onPress={onAction} style={styles.action}>
          <Text variant="label" tone="accent">
            {actionLabel}
          </Text>
          <Icon name="chevron-back" size={14} tone="accent" />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  left: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 2 },
});
