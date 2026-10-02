import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../theme';
import { Text } from '../ui/Text';

export interface BarChartProps {
  data: number[];
  labels?: string[];
  height?: number;
  color?: string;
  highlightIndex?: number;
  showValues?: boolean;
}

export function BarChart({
  data,
  labels,
  height = 140,
  color,
  highlightIndex,
  showValues = false,
}: BarChartProps) {
  const theme = useTheme();
  const max = Math.max(...data, 1);
  const barColor = color ?? theme.colors.primary;

  return (
    <View style={[styles.wrap, { height: height + (labels ? 22 : 0) }]}>
      {data.map((value, index) => {
        const ratio = value / max;
        const isHighlight = highlightIndex === index;
        return (
          <View key={index} style={styles.col}>
            <View style={[styles.track, { height }]}>
              {showValues ? (
                <Text variant="caption" tone="subtle" style={styles.value}>
                  {Math.round(value)}
                </Text>
              ) : null}
              <View
                style={{
                  width: '70%',
                  height: `${Math.max(ratio * 100, 3)}%`,
                  borderRadius: theme.radius.sm,
                  backgroundColor: isHighlight ? theme.colors.accent : barColor,
                  opacity: isHighlight ? 1 : 0.85,
                  alignSelf: 'center',
                  position: 'absolute',
                  bottom: 0,
                }}
              />
            </View>
            {labels ? (
              <Text
                variant="caption"
                tone="subtle"
                align="center"
                numberOfLines={1}
                style={{ marginTop: 4 }}
              >
                {labels[index] ?? ''}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'flex-end', gap: 6 },
  col: { flex: 1, alignItems: 'center' },
  track: { width: '100%', justifyContent: 'flex-end' },
  value: { position: 'absolute', top: -16, alignSelf: 'center' },
});
