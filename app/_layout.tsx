import React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import { ThemeProvider, useTheme } from '../src/theme';
import { FONT_ASSETS } from '../src/theme/fonts';
import { useBootstrap } from '../src/hooks/useBootstrap';
import { Auth } from '../src/screens';
import { AppShell } from '../src/components/layout/AppShell';
import { Semo0oLogo } from '../src/components/brand/Semo0oLogo';

function BootSplash() {
  const theme = useTheme();
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.background,
        gap: 20,
      }}
    >
      <Semo0oLogo size={40} orientation="stacked" tagline />
      <ActivityIndicator size="small" color={theme.colors.primary} />
    </View>
  );
}

function RootNavigator() {
  const theme = useTheme();
  const { ready, error, retry, status } = useBootstrap();

  // HARD GATE: while the session is being restored show a splash; with no live
  // session render ONLY the sign-in screen. No application route is mounted for
  // an unauthenticated visitor, so possessing the URL is not enough to open it.
  if (status === 'loading') return <BootSplash />;
  if (status === 'anonymous') {
    return (
      <>
        <StatusBar style={theme.mode === 'dark' ? 'light' : 'dark'} />
        <Auth />
      </>
    );
  }

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
      <AppShell>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: theme.colors.background },
            animation: 'fade',
          }}
        >
          <Stack.Screen name="index" />
          <Stack.Screen name="chat" />
          <Stack.Screen name="agents" />
          <Stack.Screen name="studio" />
          <Stack.Screen name="operations" />
          <Stack.Screen name="integrations" />
          <Stack.Screen name="files" />
          <Stack.Screen name="workspace" />
          <Stack.Screen name="library" />
          <Stack.Screen name="analytics" />
          <Stack.Screen name="settings" />
          <Stack.Screen name="agent/[id]" />
          <Stack.Screen name="anatomy" />
          <Stack.Screen name="privacy" />
          <Stack.Screen name="terms" />
        </Stack>
      </AppShell>
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(FONT_ASSETS);

  return (
    <SafeAreaProvider>
      <ThemeProvider initialPreference="dark" initialRTL>
        {fontsLoaded || fontError ? <RootNavigator /> : <BootSplash />}
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
