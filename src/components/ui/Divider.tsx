import React from 'react';
import { StyleSheet, View, ViewStyle, StyleProp } from 'react-native';
import { useTheme } from '../../theme';

export interface DividerProps {
  style?: StyleProp<ViewStyle>;
  vertical?: boolean;
  spacing?: number;
}

export function Divider({ style, vertical = false, spacing = 12 }: DividerProps) {
  const theme = useTheme();
  return (
    <View
      style={[
        vertical
          ? { width: StyleSheet.hairlineWidth, alignSelf: 'stretch', marginHorizontal: spacing }
          : { height: StyleSheet.hairlineWidth, marginVertical: spacing },
        { backgroundColor: theme.colors.border },
        style,
      ]}
    />
  );
}
