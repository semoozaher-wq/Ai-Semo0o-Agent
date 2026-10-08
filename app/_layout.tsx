import React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
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
  const { ready, error, retry } = useBootstrap();

  if (error) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: theme.colors.background, gap: 16 }}>
        <Text style={{ color: theme.colors.text, fontSize: 18, textAlign: 'center' }}>تعذر تحميل التطبيق</Text>
        <Text style={{ color: theme.colors.textMuted, textAlign: 'center' }}>{error}</Text>
        <Pressable onPress={retry} style={{ backgroundColor: theme.colors.primary, borderRadius: 12, paddingHorizontal: 20, paddingVertical: 12 }}>
          <Text style={{ color: '#fff', fontWeight: '700' }}>إعادة المحاولة</Text>
        </Pressable>
      </View>
    );
  }
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
        <Stack.Screen name="operations" />
        <Stack.Screen name="creation" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="privacy" />
        <Stack.Screen name="terms" />
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
