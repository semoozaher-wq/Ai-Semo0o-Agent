import React from 'react';
import { StyleSheet, View, ViewStyle, StyleProp } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { GradientName, gradients } from '../../theme';

export interface GradientProps {
  name?: GradientName;
  colors?: readonly string[];
  style?: StyleProp<ViewStyle>;
  radius?: number;
  horizontal?: boolean;
  children?: React.ReactNode;
}

/**
 * Cross-platform gradient surface. Uses react-native-svg (already a dependency)
 * so it renders identically on web and native without extra packages.
 */
export function Gradient({
  name = 'brand',
  colors,
  style,
  radius = 0,
  horizontal = false,
  children,
}: GradientProps) {
  const id = `grad-${name}-${React.useId().replace(/:/g, '')}`;
  const stops = colors ?? gradients[name];

  return (
    <View style={[{ overflow: 'hidden', borderRadius: radius }, style]}>
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
        <Defs>
          <LinearGradient
            id={id}
            x1="0"
            y1="0"
            x2={horizontal ? '1' : '0'}
            y2={horizontal ? '0' : '1'}
          >
            {stops.map((color, index) => (
              <Stop
                key={index}
                offset={stops.length === 1 ? 0 : index / (stops.length - 1)}
                stopColor={color}
              />
            ))}
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
      {children}
    </View>
  );
}
