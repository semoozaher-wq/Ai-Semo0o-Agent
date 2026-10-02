import React from 'react';
import { View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { useTheme } from '../../theme';
import { Text } from '../ui/Text';
import { clamp } from '../../utils/array';

export interface ProgressRingProps {
  /** 0..1 */
  value: number;
  size?: number;
  thickness?: number;
  color?: string;
  label?: string;
  sublabel?: string;
}

export function ProgressRing({
  value,
  size = 120,
  thickness = 12,
  color,
  label,
  sublabel,
}: ProgressRingProps) {
  const theme = useTheme();
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = clamp(value, 0, 1);
  const dash = progress * circumference;

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
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={color ?? theme.colors.primary}
          strokeWidth={thickness}
          strokeDasharray={`${dash} ${circumference - dash}`}
          strokeLinecap="round"
          fill="none"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
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
        <Text variant="title" weight="extrabold">
          {label ?? `${Math.round(progress * 100)}%`}
        </Text>
        {sublabel ? (
          <Text variant="caption" tone="subtle">
            {sublabel}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
