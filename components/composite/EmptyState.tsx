import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../theme';
import { Text } from '../ui/Text';
import { Icon, IconName } from '../ui/Icon';
import { Button } from '../ui/Button';

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({
  icon = 'sparkles-outline',
  title,
  description,
  actionLabel,
  onAction,
}: EmptyStateProps) {
  const theme = useTheme();
  return (
    <View style={[styles.wrap, { paddingVertical: theme.spacing['4xl'] }]}>
      <View
        style={[
          styles.icon,
          { backgroundColor: theme.colors.primarySoft, borderRadius: 999 },
        ]}
      >
        <Icon name={icon} size={30} tone="primary" />
      </View>
      <Text variant="subtitle" weight="bold" align="center" style={{ marginTop: theme.spacing.lg }}>
        {title}
      </Text>
      {description ? (
        <Text
          variant="body"
          tone="muted"
          align="center"
          style={{ marginTop: 6, maxWidth: 320 }}
        >
          {description}
        </Text>
      ) : null}
      {actionLabel && onAction ? (
        <Button
          label={actionLabel}
          onPress={onAction}
          variant="primary"
          style={{ marginTop: theme.spacing.xl }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  icon: { width: 64, height: 64, alignItems: 'center', justifyContent: 'center' },
});
