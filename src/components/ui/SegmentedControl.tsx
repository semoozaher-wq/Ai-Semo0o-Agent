import React from 'react';
import {
  Pressable,
  StyleProp,
  StyleSheet,
  View,
  ViewStyle,
} from 'react-native';
import { useTheme } from '../../theme';
import { Text } from './Text';
import { Icon, IconName } from './Icon';

export interface SegmentOption<T extends string> {
  label: string;
  value: T;
  icon?: IconName;
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  style?: StyleProp<ViewStyle>;
  /** Full width (default) or hug content. */
  fullWidth?: boolean;
}

/**
 * Accessible segmented control used for binary / tri-state choices
 * (login vs register, dark vs light vs system, etc.).
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  style,
  fullWidth = true,
}: SegmentedControlProps<T>) {
  const theme = useTheme();

  return (
    <View
      style={[
        styles.track,
        {
          backgroundColor: theme.colors.surfaceMuted,
          borderRadius: theme.radius.pill,
          padding: 4,
          borderColor: theme.colors.border,
        },
        fullWidth ? styles.full : styles.hug,
        style,
      ]}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => onChange(opt.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={({ pressed }) => [
              styles.item,
              fullWidth ? styles.itemFlex : styles.itemHug,
              {
                backgroundColor: active ? theme.colors.primary : 'transparent',
                borderRadius: theme.radius.pill,
                opacity: pressed ? 0.85 : 1,
              },
            ]}
          >
            {opt.icon ? (
              <View style={{ marginEnd: 6 }}>
                <Icon
                  name={opt.icon}
                  size={15}
                  {...(active
                    ? { color: theme.colors.onPrimary }
                    : { tone: 'muted' as const })}
                />
              </View>
            ) : null}
            <Text
              variant="label"
              weight="semibold"
              align="center"
              numberOfLines={1}
              style={{
                color: active ? theme.colors.onPrimary : theme.colors.textMuted,
              }}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    borderWidth: StyleSheet.hairlineWidth,
  },
  full: { alignSelf: 'stretch' },
  hug: { alignSelf: 'flex-start' },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 9,
    paddingHorizontal: 14,
  },
  itemFlex: { flex: 1 },
  itemHug: {},
});
