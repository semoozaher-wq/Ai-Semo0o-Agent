import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../theme';
import { Card } from '../ui/Card';
import { Text } from '../ui/Text';
import { Icon, IconName } from '../ui/Icon';
import { Sparkline } from '../charts/Sparkline';

export interface StatCardProps {
  label: string;
  value: string;
  icon: IconName;
  tone?: string | undefined;
  trend?: number[] | undefined;
  delta?: string | undefined;
  onPress?: (() => void) | undefined;
}

export function StatCard({
  label,
  value,
  icon,
  tone,
  trend,
  delta,
  onPress,
}: StatCardProps) {
  const theme = useTheme();
  const accent = tone ?? theme.colors.primary;

  return (
    <Card onPress={onPress} style={styles.card}>
      <View style={styles.row}>
        <View
          style={[
            styles.iconWrap,
            { backgroundColor: `${accent}22`, borderRadius: theme.radius.md },
          ]}
        >
          <Icon name={icon} size={18} color={accent} />
        </View>
        {delta ? (
          <Text variant="caption" tone="success">
            {delta}
          </Text>
        ) : null}
      </View>
      <Text variant="title" weight="extrabold" style={{ marginTop: theme.spacing.md }}>
        {value}
      </Text>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      {trend && trend.length > 1 ? (
        <View style={{ marginTop: theme.spacing.sm }}>
          <Sparkline data={trend} color={accent} width={120} height={32} />
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { flex: 1, minWidth: 150 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  iconWrap: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
});
