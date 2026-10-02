import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '../../theme';
import { Text } from '../ui/Text';
import { Icon, IconName } from '../ui/Icon';

export interface ListRowProps {
  title: string;
  subtitle?: string;
  icon?: IconName;
  iconColor?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  showChevron?: boolean;
}

export function ListRow({
  title,
  subtitle,
  icon,
  iconColor,
  right,
  onPress,
  showChevron = false,
}: ListRowProps) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [
        styles.row,
        {
          paddingVertical: theme.spacing.md,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      {icon ? (
        <View
          style={[
            styles.icon,
            { backgroundColor: theme.colors.surfaceMuted, borderRadius: theme.radius.md },
          ]}
        >
          <Icon name={icon} size={18} color={iconColor ?? theme.colors.primary} />
        </View>
      ) : null}
      <View style={styles.text}>
        <Text variant="body" weight="medium" numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" tone="subtle" numberOfLines={2} style={{ marginTop: 2 }}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
      {showChevron ? (
        <View style={{ marginStart: 8 }}>
          <Icon name="chevron-back" size={16} tone="subtle" />
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  icon: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center', marginEnd: 12 },
  text: { flex: 1 },
});
