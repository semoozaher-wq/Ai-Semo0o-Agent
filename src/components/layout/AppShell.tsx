import React from 'react';
import { StyleSheet, View } from 'react-native';
import { usePathname } from 'expo-router';
import { useTheme } from '../../theme';
import { useResponsive } from '../../hooks/useResponsive';
import { activeKeyForPath } from '../../navigation/navItems';
import { Sidebar } from './Sidebar';
import { MobileBottomBar, MobileDrawer, MobileTopBar } from './MobileNav';

/**
 * The application shell — a responsive frame that presents the Semo0o
 * navigation as a full side rail on desktop, an icon rail on tablet and a
 * top-bar + bottom-bar + drawer pattern on mobile. The active route drives the
 * highlighted item on every breakpoint.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  const { isDesktop, isTablet } = useResponsive();
  const pathname = usePathname();
  const activeKey = activeKeyForPath(pathname);
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  // Close the drawer whenever the route changes.
  React.useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  if (isDesktop || isTablet) {
    return (
      <View style={[styles.row, { backgroundColor: theme.colors.background }]}>
        {/* In RTL a `row` lays out right-to-left, so the content (first child)
            sits on the right and the rail sits on the left — matching the
            reference design. */}
        <View style={styles.content}>{children}</View>
        <Sidebar activeKey={activeKey} collapsed={isTablet} />
      </View>
    );
  }

  return (
    <View style={[styles.column, { backgroundColor: theme.colors.background }]}>
      <MobileTopBar onMenu={() => setDrawerOpen(true)} />
      <View style={styles.content}>{children}</View>
      <MobileBottomBar activeKey={activeKey} />
      <MobileDrawer
        visible={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        activeKey={activeKey}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: 'row' },
  column: { flex: 1, flexDirection: 'column' },
  content: { flex: 1, minWidth: 0 },
});
