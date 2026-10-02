import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../theme';
import { Icon } from './Icon';
import { Text } from './Text';

export interface RatingProps {
  value: number;
  size?: number;
  count?: number;
  showValue?: boolean;
}

export function Rating({ value, size = 14, count, showValue = true }: RatingProps) {
  const theme = useTheme();
  const stars = [1, 2, 3, 4, 5];

  return (
    <View style={styles.row}>
      {stars.map((star) => {
        const name =
          value >= star
            ? 'star'
            : value >= star - 0.5
              ? 'star-half'
              : 'star-outline';
        return (
          <Icon key={star} name={name} size={size} color={theme.colors.warning} />
        );
      })}
      {showValue ? (
        <Text
          variant="caption"
          tone="muted"
          style={{ marginStart: 6 }}
        >
          {value.toFixed(1)}
          {count != null ? ` (${count.toLocaleString('en')})` : ''}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
});
