import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Link, Stack } from 'expo-router';
import { useTheme } from '../src/theme';
import { Screen } from '../src/components/ui/Screen';
import { Text } from '../src/components/ui/Text';
import { Icon } from '../src/components/ui/Icon';
import { Button } from '../src/components/ui/Button';

export default function NotFoundScreen() {
  const theme = useTheme();
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <Screen>
        <View style={styles.wrap}>
          <View
            style={[
              styles.iconWrap,
              { backgroundColor: theme.colors.primarySoft, borderRadius: 999 },
            ]}
          >
            <Icon name="compass-outline" size={40} tone="primary" />
          </View>
          <Text variant="title" weight="extrabold" align="center" style={{ marginTop: 20 }}>
            الصفحة غير موجودة
          </Text>
          <Text variant="body" tone="muted" align="center" style={{ marginTop: 8 }}>
            الرابط الذي تحاول الوصول إليه غير متاح داخل التطبيق.
          </Text>
          <Link href="/" asChild>
            <View style={{ marginTop: 24, width: '100%' }}>
              <Button label="العودة للرئيسية" icon="home-outline" fullWidth />
            </View>
          </Link>
        </View>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  iconWrap: { width: 88, height: 88, alignItems: 'center', justifyContent: 'center' },
});
