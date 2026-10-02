import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../theme';
import { Text } from './Text';
import { initials } from '../../utils/format';

export interface AvatarProps {
  name?: string;
  emoji?: string;
  size?: number;
  color?: string;
  ring?: boolean;
}

export function Avatar({
  name = '',
  emoji,
  size = 44,
  color,
  ring = false,
}: AvatarProps) {
  const theme = useTheme();
  const background = color ?? theme.colors.primary;

  return (
    <View
      style={[
        styles.base,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: background,
          borderWidth: ring ? 2 : 0,
          borderColor: theme.colors.background,
        },
      ]}
    >
      <Text
        align="center"
        weight="bold"
        style={{
          color: '#FFFFFF',
          fontSize: emoji ? size * 0.5 : size * 0.38,
        }}
      >
        {emoji ?? initials(name)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center' },
});
