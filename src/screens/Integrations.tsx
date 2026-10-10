import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTheme } from '../theme';
import { AppHeader } from '../components/composite/AppHeader';
import { IntegrationsCard } from '../components/composite/IntegrationsCard';
import { SystemStatusCard } from '../components/composite/SystemStatusCard';
import { SectionHeader } from '../components/composite/SectionHeader';
import { Card } from '../components/ui/Card';
import { Text } from '../components/ui/Text';
import { Icon } from '../components/ui/Icon';
import type { IconName } from '../components/ui/Icon';
import { Screen } from '../components/ui/Screen';

const CAPABILITIES: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'logo-github',
    title: 'GitHub',
    body: 'استيراد المستودعات، إنشاء الفروع، وفتح طلبات السحب مباشرةً من مساحة العمل.',
  },
  {
    icon: 'search-outline',
    title: 'البحث في الويب',
    body: 'بحث حقيقي في الويب واسترجاع مصادر محدّثة لبناء الإجابات والمراجع.',
  },
  {
    icon: 'terminal-outline',
    title: 'تنفيذ الكود',
    body: 'تشغيل الكود داخل بيئة معزولة آمنة ثم إرجاع النتائج والملفات.',
  },
  {
    icon: 'sparkles-outline',
    title: 'توليد الوسائط',
    body: 'توليد الصور والصوت والفيديو ودمجها في المخرجات النهائية.',
  },
];

export function Integrations() {
  const theme = useTheme();
  return (
    <Screen padded={false}>
      <ScrollView
        contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: 48 }}
        showsVerticalScrollIndicator={false}
      >
        <AppHeader
          title="التكاملات"
          subtitle="اربط أدواتك وخدماتك مع Semo0o Agent"
        />

        <IntegrationsCard />

        <View style={{ height: theme.spacing.xl }} />

        <SectionHeader title="القدرات المتاحة" icon="apps-outline" />
        <View style={styles.grid}>
          {CAPABILITIES.map((cap) => (
            <Card key={cap.title} style={styles.cell} elevation="sm">
              <View style={styles.cellHead}>
                <View
                  style={[
                    styles.iconWrap,
                    { backgroundColor: theme.colors.primarySoft, borderRadius: theme.radius.md },
                  ]}
                >
                  <Icon name={cap.icon} size={20} tone="primary" />
                </View>
                <Text variant="subtitle" weight="bold" style={{ marginStart: 12 }}>
                  {cap.title}
                </Text>
              </View>
              <Text variant="caption" tone="muted" style={{ marginTop: 10, lineHeight: 20 }}>
                {cap.body}
              </Text>
            </Card>
          ))}
        </View>

        <View style={{ height: theme.spacing.xl }} />
        <SectionHeader title="حالة النظام" icon="pulse-outline" />
        <SystemStatusCard />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  cell: { flexGrow: 1, flexBasis: 260, minWidth: 240 },
  cellHead: { flexDirection: 'row', alignItems: 'center' },
  iconWrap: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
});
