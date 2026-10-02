import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../theme';
import { Text } from '../ui/Text';

export interface AppHeaderProps {
  title: string;
  subtitle?: string;
  left?: React.ReactNode;
  right?: React.ReactNode;
}

export function AppHeader({ title, subtitle, left, right }: AppHeaderProps) {
  const theme = useTheme();
  return (
    <View style={[styles.row, { marginBottom: theme.spacing.lg }]}>
      <View style={styles.left}>
        {left ? <View style={{ marginEnd: 12 }}>{left}</View> : null}
        <View style={{ flex: 1 }}>
          <Text variant="title" weight="extrabold">
            {title}
          </Text>
          {subtitle ? (
            <Text variant="caption" tone="muted" style={{ marginTop: 2 }}>
              {subtitle}
            </Text>
          ) : null}
        </View>
      </View>
      {right ? <View style={styles.right}>{right}</View> : null}
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
  right: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
