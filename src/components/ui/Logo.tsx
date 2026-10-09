import React from 'react';
import { StyleProp, ViewStyle } from 'react-native';
import { GradientName } from '../../theme';
import { Gradient } from './Gradient';
import { Icon, IconName } from './Icon';

export interface LogoProps {
  size?: number;
  gradient?: GradientName;
  icon?: IconName;
  /** Corner radius. Defaults to a squircle derived from the size. */
  radius?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * The Semo0o brand mark — a gradient squircle with a glyph. Used on the auth
 * gate, headers and empty states so the identity stays consistent.
 */
export function Logo({
  size = 44,
  gradient = 'brand',
  icon = 'sparkles',
  radius,
  style,
}: LogoProps) {
  return (
    <Gradient
      name={gradient}
      radius={radius ?? Math.round(size * 0.3)}
      style={[
        { width: size, height: size, alignItems: 'center', justifyContent: 'center' },
        style,
      ]}
    >
      <Icon name={icon} size={Math.round(size * 0.46)} color="#FFFFFF" />
    </Gradient>
  );
}
