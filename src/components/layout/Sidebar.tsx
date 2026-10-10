import React from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme, useThemeController } from '../../theme';
import { Icon } from '../ui/Icon';
import { Text } from '../ui/Text';
import { Gradient } from '../ui/Gradient';
import { Semo0oLogo, Semo0oMark } from '../brand/Semo0oLogo';
import { MAIN_NAV, SECONDARY_NAV, NavItem } from '../../navigation/navItems';

export interface SidebarProps {
  activeKey?: string | undefined;
  /** Icons-only rail (tablet). */
  collapsed?: boolean;
}

function NavButton({
  item,
  active,
  collapsed,
  onPress,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const [hover, setHover] = React.useState(false);

  const content = (
    <View
      style={[
        styles.itemInner,
        collapsed && { justifyContent: 'center', paddingHorizontal: 0 },
      ]}
    >
      <Icon
        name={active ? item.iconActive : item.icon}
        size={collapsed ? 22 : 20}
        color={active ? '#FFFFFF' : theme.colors.textMuted}
      />
      {!collapsed ? (
        <Text
          weight={active ? 'bold' : 'medium'}
          style={{
            marginStart: 12,
            fontSize: theme.fontSize.md,
            color: active ? '#FFFFFF' : theme.colors.textMuted,
          }}
          numberOfLines={1}
        >
          {item.label}
        </Text>
      ) : null}
    </View>
  );

  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHover(true)}
      onHoverOut={() => setHover(false)}
      accessibilityRole="link"
      accessibilityLabel={item.label}
      style={({ pressed }) => [
        styles.item,
        collapsed && styles.itemCollapsed,
        {
          backgroundColor: active
            ? 'transparent'
            : hover
              ? theme.colors.surfaceHover
              : 'transparent',
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      {active ? (
        <Gradient
          name="brand"
          horizontal
          radius={14}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      {content}
    </Pressable>
  );
}

/**
 * The Semo0o side rail — brand lockup, primary navigation, secondary tools and
 * a footer. Collapses to an icon-only rail on tablets.
 */
export function Sidebar({ activeKey, collapsed = false }: SidebarProps) {
  const theme = useTheme();
  const router = useRouter();
  const { mode, toggleMode } = useThemeController();

  const go = (href: string) => {
    router.push(href as never);
  };

  return (
    <View
      style={[
        styles.root,
        {
          width: collapsed ? 78 : 268,
          backgroundColor: theme.colors.backgroundElevated,
          borderColor: theme.colors.border,
        },
      ]}
    >
      <Gradient name="rail" style={StyleSheet.absoluteFill} />

      {/* brand */}
      <View style={[styles.brand, collapsed && { justifyContent: 'center', paddingHorizontal: 0 }]}>
        {collapsed ? (
          <Semo0oMark size={38} />
        ) : (
          <Semo0oLogo size={34} tagline />
        )}
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: collapsed ? 10 : 14, paddingBottom: 16 }}
      >
        {!collapsed ? (
          <Text
            variant="caption"
            weight="bold"
            tone="subtle"
            style={{ marginBottom: 8, marginStart: 6, letterSpacing: 1 }}
          >
            القائمة
          </Text>
        ) : null}
        {MAIN_NAV.map((item) => (
          <NavButton
            key={item.key}
            item={item}
            active={activeKey === item.key}
            collapsed={collapsed}
            onPress={() => go(item.href)}
          />
        ))}

        <View
          style={{
            height: StyleSheet.hairlineWidth,
            backgroundColor: theme.colors.border,
            marginVertical: 12,
          }}
        />

        {!collapsed ? (
          <Text
            variant="caption"
            weight="bold"
            tone="subtle"
            style={{ marginBottom: 8, marginStart: 6, letterSpacing: 1 }}
          >
            أدوات
          </Text>
        ) : null}
        {SECONDARY_NAV.map((item) => (
          <NavButton
            key={item.key}
            item={item}
            active={activeKey === item.key}
            collapsed={collapsed}
            onPress={() => go(item.href)}
          />
        ))}
      </ScrollView>

      {/* footer */}
      <View
        style={[
          styles.footer,
          { borderColor: theme.colors.border },
          collapsed && { justifyContent: 'center', paddingHorizontal: 0 },
        ]}
      >
        <Pressable
          onPress={toggleMode}
          accessibilityLabel="تبديل المظهر"
          style={({ pressed }) => [
            styles.footerBtn,
            collapsed && { justifyContent: 'center' },
            { opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <Icon name={mode === 'dark' ? 'sunny-outline' : 'moon-outline'} size={18} tone="muted" />
          {!collapsed ? (
            <Text style={{ marginStart: 10, color: theme.colors.textMuted, fontSize: theme.fontSize.sm }}>
              {mode === 'dark' ? 'الوضع الفاتح' : 'الوضع الداكن'}
            </Text>
          ) : null}
        </Pressable>
        {!collapsed ? (
          <Text variant="caption" tone="subtle" style={{ marginTop: 10, marginStart: 2 }}>
            Semo0o Agent © 2025
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    borderEndWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingTop: 22,
    paddingBottom: 18,
  },
  item: {
    borderRadius: 14,
    marginBottom: 4,
    overflow: 'hidden',
  },
  itemCollapsed: {
    marginBottom: 6,
  },
  itemInner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  footerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
  },
});
