import React from 'react';
import { View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { useTheme } from '../../theme';
import { Text } from '../ui/Text';

export interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

export interface DonutChartProps {
  segments: DonutSegment[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerSub?: string;
}

export function DonutChart({
  segments,
  size = 160,
  thickness = 18,
  centerLabel,
  centerSub,
}: DonutChartProps) {
  const theme = useTheme();
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const total = segments.reduce((acc, s) => acc + s.value, 0) || 1;

  const dashes = segments.map((s) => (s.value / total) * circumference);
  const arcs = segments.map((segment, index) => ({
    segment,
    dash: dashes[index],
    gap: circumference - dashes[index],
    offset: dashes.slice(0, index).reduce((a, b) => a + b, 0),
  }));

  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={theme.colors.surfaceMuted}
          strokeWidth={thickness}
          fill="none"
        />
        {arcs.map(({ segment, dash, gap, offset }, index) => (
          <Circle
            key={index}
            cx={size / 2}
            cy={size / 2}
            r={radius}
            stroke={segment.color}
            strokeWidth={thickness}
            strokeDasharray={`${dash} ${gap}`}
            strokeDashoffset={-offset}
            strokeLinecap="butt"
            fill="none"
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        ))}
      </Svg>
      <View
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {centerLabel ? (
          <Text variant="title" weight="extrabold">
            {centerLabel}
          </Text>
        ) : null}
        {centerSub ? (
          <Text variant="caption" tone="subtle">
            {centerSub}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
