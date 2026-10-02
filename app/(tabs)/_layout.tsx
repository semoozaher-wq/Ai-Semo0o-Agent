import React from 'react';
import { StyleSheet } from 'react-native';
import { Tabs } from 'expo-router';
import { useTheme } from '../../src/theme';
import { Icon } from '../../src/components/ui/Icon';
import type { IconName } from '../../src/components/ui/Icon';

interface TabDef {
  name: string;
  title: string;
  icon: IconName;
}

const TABS: TabDef[] = [
  { name: 'index', title: 'الرئيسية', icon: 'grid-outline' },
  { name: 'store', title: 'المتجر', icon: 'storefront-outline' },
  { name: 'chat', title: 'المحادثة', icon: 'chatbubbles-outline' },
  { name: 'agents', title: 'الوكلاء', icon: 'rocket-outline' },
  { name: 'files', title: 'الملفات', icon: 'folder-open-outline' },
];

export default function TabsLayout() {
  const theme = useTheme();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.textSubtle,
        tabBarStyle: {
          backgroundColor: theme.colors.backgroundElevated,
          borderTopColor: theme.colors.border,
          borderTopWidth: StyleSheet.hairlineWidth,
          height: 64,
          paddingTop: 8,
          paddingBottom: 8,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '700' },
      }}
    >
      {TABS.map((tab) => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={{
            title: tab.title,
            tabBarIcon: ({ color, size }) => (
              <Icon name={tab.icon} size={size} color={color as string} />
            ),
          }}
        />
      ))}
    </Tabs>
  );
}
