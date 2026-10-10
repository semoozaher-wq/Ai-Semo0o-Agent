import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, useThemeController } from '../../theme';
import { Icon } from '../ui/Icon';
import { Text } from '../ui/Text';
import { Gradient } from '../ui/Gradient';
import { Semo0oLogo } from '../brand/Semo0oLogo';
import { MAIN_NAV, MOBILE_TABS, SECONDARY_NAV, NavItem } from '../../navigation/navItems';

function useGo() {
  const router = useRouter();
  return React.useCallback(
    (href: string) => {
      router.push(href as never);
    },
    [router],
  );
}

/* ------------------------------- top bar -------------------------------- */

export function MobileTopBar({ onMenu }: { onMenu: () => void }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  return (
    <View
      style={[
        styles.topBar,
        {
          paddingTop: insets.top + 8,
          backgroundColor: theme.colors.backgroundElevated,
          borderColor: theme.colors.border,
        },
      ]}
    >
      <Pressable
        onPress={onMenu}
        accessibilityLabel="القائمة"
        style={({ pressed }) => [styles.iconBtn, { opacity: pressed ? 0.7 : 1 }]}
      >
        <Icon name="menu-outline" size={24} tone="default" />
      </Pressable>
      <Pressable onPress={() => router.push('/' as never)} style={styles.centerBrand}>
        <Semo0oLogo size={26} />
      </Pressable>
      <Pressable
        onPress={() => router.push('/settings' as never)}
        accessibilityLabel="الإعدادات"
        style={({ pressed }) => [styles.iconBtn, { opacity: pressed ? 0.7 : 1 }]}
      >
        <Icon name="settings-outline" size={22} tone="muted" />
      </Pressable>
    </View>
  );
}

/* ------------------------------ bottom bar ------------------------------ */

export function MobileBottomBar({ activeKey }: { activeKey?: string | undefined }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const go = useGo();

  return (
    <View
      style={[
        styles.bottomBar,
        {
          paddingBottom: Math.max(insets.bottom, 8),
          backgroundColor: theme.colors.backgroundElevated,
          borderColor: theme.colors.border,
        },
      ]}
    >
      {MOBILE_TABS.map((item) => {
        const active = activeKey === item.key;
        return (
          <Pressable
            key={item.key}
            onPress={() => go(item.href)}
            accessibilityRole="link"
            accessibilityLabel={item.label}
            style={({ pressed }) => [styles.tab, { opacity: pressed ? 0.7 : 1 }]}
          >
            <View style={styles.tabIcon}>
              {active ? (
                <Gradient name="brand" radius={12} style={styles.tabPill} />
              ) : null}
              <Icon
                name={active ? item.iconActive : item.icon}
                size={21}
                color={active ? '#FFFFFF' : theme.colors.textSubtle}
              />
            </View>
            <Text
              style={{
                fontSize: 10,
                marginTop: 3,
                fontWeight: active ? '700' : '500',
                color: active ? theme.colors.text : theme.colors.textSubtle,
              }}
              numberOfLines={1}
            >
              {item.short ?? item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/* -------------------------------- drawer -------------------------------- */

function DrawerRow({
  item,
  active,
  onPress,
}: {
  item: NavItem;
  active: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.drawerRow,
        {
          backgroundColor: active ? theme.colors.primarySoft : 'transparent',
          opacity: pressed ? 0.8 : 1,
        },
      ]}
    >
      <Icon
        name={active ? item.iconActive : item.icon}
        size={20}
        color={active ? theme.colors.primary : theme.colors.textMuted}
      />
      <Text
        weight={active ? 'bold' : 'medium'}
        style={{
          marginStart: 14,
          fontSize: theme.fontSize.md,
          color: active ? theme.colors.text : theme.colors.textMuted,
        }}
      >
        {item.label}
      </Text>
    </Pressable>
  );
}

export function MobileDrawer({
  visible,
  onClose,
  activeKey,
}: {
  visible: boolean;
  onClose: () => void;
  activeKey?: string | undefined;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const go = useGo();
  const { mode, toggleMode } = useThemeController();

  const navigate = (href: string) => {
    onClose();
    // let the modal close before routing
    setTimeout(() => go(href), 60);
  };

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="إغلاق القائمة">
        <Pressable
          style={[
            styles.drawer,
            {
              backgroundColor: theme.colors.backgroundElevated,
              paddingTop: insets.top + 20,
              paddingBottom: insets.bottom + 16,
            },
          ]}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={styles.drawerBrand}>
            <Semo0oLogo size={30} tagline />
          </View>
          <ScrollView showsVerticalScrollIndicator={false}>
            {MAIN_NAV.map((item) => (
              <DrawerRow
                key={item.key}
                item={item}
                active={activeKey === item.key}
                onPress={() => navigate(item.href)}
              />
            ))}
            <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />
            {SECONDARY_NAV.map((item) => (
              <DrawerRow
                key={item.key}
                item={item}
                active={activeKey === item.key}
                onPress={() => navigate(item.href)}
              />
            ))}
          </ScrollView>
          <Pressable
            onPress={toggleMode}
            style={({ pressed }) => [styles.drawerFooter, { opacity: pressed ? 0.7 : 1 }]}
          >
            <Icon name={mode === 'dark' ? 'sunny-outline' : 'moon-outline'} size={18} tone="muted" />
            <Text style={{ marginStart: 10, color: theme.colors.textMuted }}>
              {mode === 'dark' ? 'الوضع الفاتح' : 'الوضع الداكن'}
            </Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
  },
  centerBrand: { flexDirection: 'row', alignItems: 'center' },
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 2 },
  tabIcon: { width: 40, height: 30, alignItems: 'center', justifyContent: 'center' },
  tabPill: { position: 'absolute', width: 40, height: 30, borderRadius: 12 },
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(3,6,20,0.6)',
    flexDirection: 'row',
    justifyContent: 'flex-start',
  },
  drawer: {
    width: 300,
    maxWidth: '84%',
    height: '100%',
    paddingHorizontal: 16,
    borderEndWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(148,163,255,0.14)',
  },
  drawerBrand: { marginBottom: 18, paddingHorizontal: 6 },
  drawerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    paddingHorizontal: 12,
    borderRadius: 12,
    marginBottom: 2,
  },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 12 },
  drawerFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
  },
});
