import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../theme';
import { AgentManifest } from '../../types/agent';
import { Card } from '../ui/Card';
import { Text } from '../ui/Text';
import { Badge } from '../ui/Badge';
import { Rating } from '../ui/Rating';
import { Button } from '../ui/Button';
import { formatNumber } from '../../utils/format';

export interface AgentCardProps {
  agent: AgentManifest;
  installed?: boolean;
  updateAvailable?: boolean;
  installing?: boolean;
  onPress?: () => void;
  onInstall?: () => void;
  compact?: boolean;
}

export function AgentCard({
  agent,
  installed = false,
  updateAvailable = false,
  installing = false,
  onPress,
  onInstall,
  compact = false,
}: AgentCardProps) {
  const theme = useTheme();

  return (
    <Card onPress={onPress} style={compact ? styles.compact : undefined}>
      <View style={styles.header}>
        <View
          style={[
            styles.icon,
            {
              backgroundColor: `${agent.accent}22`,
              borderRadius: theme.radius.lg,
            },
          ]}
        >
          <Text align="center" style={{ fontSize: 26 }}>
            {agent.icon}
          </Text>
        </View>
        <View style={styles.info}>
          <View style={styles.nameRow}>
            <Text variant="subtitle" weight="bold" numberOfLines={1} style={styles.name}>
              {agent.nameAr}
            </Text>
            {agent.authorVerified ? (
              <Badge label="موثّق" tone="accent" />
            ) : null}
          </View>
          <Text variant="caption" tone="muted" numberOfLines={2} style={{ marginTop: 2 }}>
            {agent.taglineAr}
          </Text>
        </View>
      </View>

      {!compact ? (
        <View style={[styles.meta, { marginTop: theme.spacing.md }]}>
          <Rating value={agent.rating} count={agent.ratingCount} />
          <Text variant="caption" tone="subtle">
            {formatNumber(agent.installs)} تنزيل · {agent.sizeMb}MB
          </Text>
        </View>
      ) : null}

      <View style={[styles.actions, { marginTop: theme.spacing.md }]}>
        <Badge
          label={agent.pricing === 'free' ? 'مجاني' : agent.priceLabel ?? 'مدفوع'}
          tone={agent.pricing === 'free' ? 'success' : 'warning'}
        />
        <Button
          label={installing ? 'جارٍ التثبيت…' : installed ? 'مثبّت' : 'تثبيت'}
          icon={installed ? 'checkmark' : 'download-outline'}
          variant={updateAvailable ? 'primary' : installed ? 'secondary' : 'primary'}
          size="sm"
          loading={installing}
          disabled={installed && !updateAvailable}
          onPress={onInstall}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center' },
  icon: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center' },
  info: { flex: 1, marginStart: 12 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { flexShrink: 1 },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  compact: { minWidth: 200 },
});
