import React from 'react';
import {
  LayoutAnimation,
  Platform,
  Pressable,
  StyleProp,
  StyleSheet,
  UIManager,
  View,
  ViewStyle,
} from 'react-native';
import { useTheme } from '../../theme';
import { Text } from './Text';
import { Icon, IconName } from './Icon';
import { Divider } from './Divider';

if (
  Platform.OS === 'android' &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

export interface AccordionProps {
  title: string;
  subtitle?: string;
  icon?: IconName;
  iconColor?: string;
  /** Open on first render. Defaults to closed (progressive disclosure). */
  defaultOpen?: boolean;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

/**
 * Collapsible section used to tuck advanced / technical detail behind a clear
 * header. Keeps the primary settings surface calm while everything remains one
 * tap away — the pattern professional AI platforms use for "advanced" panels.
 */
export function Accordion({
  title,
  subtitle,
  icon = 'options-outline',
  iconColor,
  defaultOpen = false,
  children,
  style,
}: AccordionProps) {
  const theme = useTheme();
  const [open, setOpen] = React.useState(defaultOpen);

  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setOpen((prev) => !prev);
  };

  return (
    <View
      style={[
        styles.wrap,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderRadius: theme.radius.xl,
        },
        style,
      ]}
    >
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={styles.head}
      >
        <View
          style={[
            styles.iconBox,
            { backgroundColor: theme.colors.primarySoft, borderRadius: theme.radius.md },
          ]}
        >
          <Icon name={icon} size={18} color={iconColor ?? theme.colors.primary} />
        </View>
        <View style={{ flex: 1, marginStart: 12 }}>
          <Text variant="label" weight="semibold">
            {title}
          </Text>
          {subtitle ? (
            <Text variant="caption" tone="muted" style={{ marginTop: 2 }}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={18} tone="muted" />
      </Pressable>

      {open ? (
        <View>
          <Divider spacing={0} style={{ marginHorizontal: theme.spacing.lg }} />
          <View style={{ padding: theme.spacing.lg }}>{children}</View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  head: { flexDirection: 'row', alignItems: 'center', padding: 14 },
  iconBox: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
});
