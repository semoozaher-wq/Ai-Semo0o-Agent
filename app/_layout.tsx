import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider, useTheme } from '../src/theme';
import { useBootstrap } from '../src/hooks/useBootstrap';

function BootSplash() {
  const theme = useTheme();
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.background,
        gap: 16,
      }}
    >
      <ActivityIndicator size="large" color={theme.colors.primary} />
    </View>
  );
}

function RootNavigator() {
  const theme = useTheme();
  const { ready } = useBootstrap();

  if (!ready) return <BootSplash />;

  return (
    <>
      <StatusBar style={theme.mode === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.colors.background },
          animation: 'fade',
        }}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="agent/[id]" />
        <Stack.Screen name="workspace" />
        <Stack.Screen name="anatomy" />
        <Stack.Screen name="analytics" />
        <Stack.Screen name="settings" />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider initialPreference="dark" initialRTL>
        <RootNavigator />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
