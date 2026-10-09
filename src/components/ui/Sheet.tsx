import React from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { shadow, useTheme } from '../../theme';
import { Text } from './Text';
import { IconButton } from './IconButton';

export type SheetSide = 'bottom' | 'left' | 'right';

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** Where the sheet enters from. Defaults to a bottom sheet. */
  side?: SheetSide;
  /** Optional heading; when present a close button is rendered. */
  title?: string;
  subtitle?: string;
  /** Constrain height (bottom sheet). */
  maxHeight?: number | `${number}%`;
  /** Wrap children in a scroll view (default true). */
  scroll?: boolean;
  /** Rendered in a sticky footer below the scroll area. */
  footer?: React.ReactNode;
  contentStyle?: ViewStyle;
}

/**
 * Unified modal surface for the product: bottom sheets on mobile, side panels
 * for navigation. Handles scrim, safe areas, RTL-agnostic positioning and
 * keyboard-friendly scrolling so every caller looks identical.
 */
export function Sheet({
  visible,
  onClose,
  children,
  side = 'bottom',
  title,
  subtitle,
  maxHeight,
  scroll = true,
  footer,
  contentStyle,
}: SheetProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const isBottom = side === 'bottom';

  const containerStyle: ViewStyle = isBottom
    ? {
        width: '100%',
        maxHeight: maxHeight ?? '86%',
        borderTopLeftRadius: theme.radius['3xl'],
        borderTopRightRadius: theme.radius['3xl'],
        paddingTop: theme.spacing.md,
        paddingBottom: Math.max(insets.bottom, theme.spacing.lg),
        paddingHorizontal: theme.spacing.xl,
      }
    : {
        position: 'absolute',
        top: 0,
        bottom: 0,
        [side]: 0,
        width: '86%',
        maxWidth: 400,
        paddingTop: insets.top + theme.spacing.lg,
        paddingBottom: Math.max(insets.bottom, theme.spacing.lg),
        paddingHorizontal: theme.spacing.lg,
        ...(side === 'left'
          ? {
              borderTopRightRadius: theme.radius['2xl'],
              borderBottomRightRadius: theme.radius['2xl'],
            }
          : {
              borderTopLeftRadius: theme.radius['2xl'],
              borderBottomLeftRadius: theme.radius['2xl'],
            }),
      };

  return (
    <Modal
      visible={visible}
      transparent
      animationType={isBottom ? 'slide' : 'fade'}
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable
        style={[
          styles.backdrop,
          { backgroundColor: theme.colors.scrim },
          isBottom ? styles.backdropBottom : null,
        ]}
        onPress={onClose}
      >
        <Pressable
          style={[
            {
              backgroundColor: theme.colors.surfaceElevated,
              borderColor: theme.colors.border,
              borderWidth: StyleSheet.hairlineWidth,
              ...shadow('2xl', theme.colors.shadow),
            },
            containerStyle,
            contentStyle,
          ]}
          onPress={(e) => e.stopPropagation()}
        >
          {isBottom ? (
            <View
              style={[
                styles.handle,
                { backgroundColor: theme.colors.borderStrong, marginBottom: theme.spacing.md },
              ]}
            />
          ) : null}

          {title ? (
            <View style={[styles.head, { marginBottom: theme.spacing.md }]}>
              <View style={{ flex: 1 }}>
                <Text variant="subtitle" weight="bold">
                  {title}
                </Text>
                {subtitle ? (
                  <Text variant="caption" tone="muted" style={{ marginTop: 2 }}>
                    {subtitle}
                  </Text>
                ) : null}
              </View>
              <IconButton name="close" size="sm" onPress={onClose} accessibilityLabel="إغلاق" />
            </View>
          ) : null}

          {scroll ? (
            <ScrollView
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingBottom: theme.spacing.sm }}
            >
              {children}
            </ScrollView>
          ) : (
            children
          )}

          {footer ? <View style={{ marginTop: theme.spacing.md }}>{footer}</View> : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1 },
  backdropBottom: { justifyContent: 'flex-end' },
  handle: {
    width: 44,
    height: 5,
    borderRadius: 3,
    alignSelf: 'center',
  },
  head: { flexDirection: 'row', alignItems: 'center' },
});
