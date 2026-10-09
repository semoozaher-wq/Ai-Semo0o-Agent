import React from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useTheme, useThemeController } from '../theme';
import type { ThemePreference } from '../theme';
import { AppHeader } from '../components/composite/AppHeader';
import { SectionHeader } from '../components/composite/SectionHeader';
import { ListRow } from '../components/composite/ListRow';
import { SystemStatusCard } from '../components/composite/SystemStatusCard';
import { IntegrationsCard } from '../components/composite/IntegrationsCard';
import { AccountSecurityCard } from '../components/composite/AccountSecurityCard';
import { Accordion } from '../components/ui/Accordion';
import { Card } from '../components/ui/Card';
import { Text } from '../components/ui/Text';
import { Chip } from '../components/ui/Chip';
import { Badge } from '../components/ui/Badge';
import { Divider } from '../components/ui/Divider';
import { Icon } from '../components/ui/Icon';
import { Sheet } from '../components/ui/Sheet';
import { useAppStore } from '../store/useAppStore';
import { PROVIDERS, getModel, modelsByProvider } from '../data/models';
import { ProviderId } from '../types/model';
import { useRouter } from 'expo-router';

const THEME_OPTIONS: { label: string; value: ThemePreference; icon: 'moon-outline' | 'sunny-outline' | 'contrast-outline' }[] = [
  { label: 'داكن', value: 'dark', icon: 'moon-outline' },
  { label: 'فاتح', value: 'light', icon: 'sunny-outline' },
  { label: 'النظام', value: 'system', icon: 'contrast-outline' },
];

const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function Settings() {
  const theme = useTheme();
  const router = useRouter();
  const controller = useThemeController();
  const settings = useAppStore((s) => s.settings);
  const update = useAppStore((s) => s.update);
  const reset = useAppStore((s) => s.reset);

  const [modelPicker, setModelPicker] = React.useState(false);

  const activeModel = getModel(settings.activeModel);
  const activeProvider = activeModel ? PROVIDERS[activeModel.provider] : undefined;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.lg,
          paddingTop: theme.spacing.lg,
          paddingBottom: theme.spacing['4xl'],
        }}
        showsVerticalScrollIndicator={false}
      >
        <AppHeader title="الإعدادات" subtitle="التخصيص والنماذج والخصوصية" />

        {/* Appearance */}
        <SectionHeader title="المظهر" icon="color-palette-outline" />
        <Card>
          <Text variant="label" tone="muted" style={{ marginBottom: theme.spacing.sm }}>
            نمط العرض
          </Text>
          <View style={styles.chipRow}>
            {THEME_OPTIONS.map((opt) => (
              <Chip
                key={opt.value}
                label={opt.label}
                icon={opt.icon}
                selected={controller.preference === opt.value}
                onPress={() => controller.setPreference(opt.value)}
              />
            ))}
          </View>
          <Divider />
          <View style={styles.switchRow}>
            <View style={styles.switchLabel}>
              <Icon name="swap-horizontal-outline" size={18} tone="primary" />
              <View style={{ marginStart: 10 }}>
                <Text variant="label" weight="semibold">
                  الاتجاه من اليمين لليسار (RTL)
                </Text>
                <Text variant="caption" tone="muted">
                  واجهة عربية أصلية
                </Text>
              </View>
            </View>
            <Switch
              value={controller.isRTL}
              onValueChange={(v) => {
                controller.setRTL(v);
                update({ rtl: v });
              }}
              trackColor={{ true: theme.colors.primary, false: theme.colors.surfaceMuted }}
              thumbColor="#FFFFFF"
            />
          </View>
        </Card>

        {/* AI */}
        <SectionHeader title="الذكاء الاصطناعي" icon="sparkles-outline" style={{ marginTop: theme.spacing.xl }} />
        <Card padded={false}>
          <ListRow
            title="النموذج النشط"
            subtitle={activeModel?.name ?? 'غير محدد'}
            icon="hardware-chip-outline"
            iconColor={activeProvider?.accent}
            onPress={() => setModelPicker(true)}
            showChevron
            right={
              activeProvider ? (
                <Badge label={activeProvider.name} tone="primary" />
              ) : undefined
            }
          />
          <Divider spacing={0} style={{ marginHorizontal: theme.spacing.lg }} />
          <View style={[styles.switchRow, { paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.md }]}>
            <View style={styles.switchLabel}>
              <Icon name="flash-outline" size={18} tone="accent" />
              <View style={{ marginStart: 10 }}>
                <Text variant="label" weight="semibold">
                  التشغيل التلقائي للوكلاء
                </Text>
                <Text variant="caption" tone="muted">
                  تنفيذ المهام دون تأكيد يدوي
                </Text>
              </View>
            </View>
            <Switch
              value={settings.autoRun}
              onValueChange={(v) => update({ autoRun: v })}
              trackColor={{ true: theme.colors.primary, false: theme.colors.surfaceMuted }}
              thumbColor="#FFFFFF"
            />
          </View>
        </Card>

        {/* Operations console */}
        <SectionHeader
          title="لوحة العمليات"
          subtitle="التحسين الذاتي الآمن · حالة الأدوات · المراقبة والتراجع"
          icon="construct-outline"
          style={{ marginTop: theme.spacing.xl }}
        />
        <Card padded={false}>
          <ListRow
            title="مركز العمليات"
            subtitle="مراجعة مقترحات التحسين الذاتي والموافقة عليها، ومراقبة حالة كل أداة"
            icon="pulse-outline"
            iconColor={theme.colors.primary}
            onPress={() => router.push('/operations')}
            showChevron
          />
        </Card>

        {/* Privacy */}
        <SectionHeader title="الخصوصية والبيانات" icon="shield-checkmark-outline" style={{ marginTop: theme.spacing.xl }} />
        <Card padded={false}>
          <View style={[styles.switchRow, { paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.md }]}>
            <View style={styles.switchLabel}>
              <Icon name="pulse-outline" size={18} tone="primary" />
              <View style={{ marginStart: 10 }}>
                <Text variant="label" weight="semibold">
                  مشاركة بيانات الاستخدام
                </Text>
                <Text variant="caption" tone="muted">
                  تحسين التجربة عبر تحليلات مجهولة
                </Text>
              </View>
            </View>
            <Switch
              value={settings.telemetry}
              onValueChange={(v) => update({ telemetry: v })}
              trackColor={{ true: theme.colors.primary, false: theme.colors.surfaceMuted }}
              thumbColor="#FFFFFF"
            />
          </View>
          <Divider spacing={0} style={{ marginHorizontal: theme.spacing.lg }} />
          <View style={[styles.switchRow, { paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.md }]}>
            <View style={styles.switchLabel}>
              <Icon name="phone-portrait-outline" size={18} tone="accent" />
              <View style={{ marginStart: 10 }}>
                <Text variant="label" weight="semibold">
                  الاهتزاز اللمسي
                </Text>
                <Text variant="caption" tone="muted">
                  ردود فعل لمسية عند التفاعل
                </Text>
              </View>
            </View>
            <Switch
              value={settings.haptics}
              onValueChange={(v) => update({ haptics: v })}
              trackColor={{ true: theme.colors.primary, false: theme.colors.surfaceMuted }}
              thumbColor="#FFFFFF"
            />
          </View>
        </Card>

        {/* Account security */}
        <SectionHeader
          title="الأمان والحساب"
          subtitle="المصادقة الثنائية · تصدير البيانات · حذف الحساب — تُنفَّذ فعليًا على الخادم"
          icon="shield-checkmark-outline"
          style={{ marginTop: theme.spacing.xl }}
        />
        <AccountSecurityCard />

        {/* Advanced — technical detail tucked away */}
        <SectionHeader
          title="إعدادات متقدمة"
          subtitle="معلومات تقنية للمزوّدين وحالة النظام والتكاملات"
          icon="options-outline"
          style={{ marginTop: theme.spacing.xl }}
        />
        <View style={{ gap: 12 }}>
          <Accordion
            title="مزوّدو الذكاء الاصطناعي"
            subtitle="اتصال آمن من الخادم — المفاتيح لا تُحفظ في التطبيق"
            icon="key-outline"
          >
            <Text variant="body" weight="semibold">
              اتصال آمن من الخادم
            </Text>
            <Text variant="caption" tone="muted" style={{ marginTop: theme.spacing.sm }}>
              يختار الـBackend OpenAI أو Gemini أو Anthropic حسب النموذج المتاح. اضبط المفاتيح كأسرار بيئية على الخادم، ثم أعد تشغيل العامل. لا يُسمح للعميل برؤية قيمة أي مفتاح.
            </Text>
            <View style={[styles.chipRow, { marginTop: theme.spacing.md }]}>
              {PROVIDER_IDS.map((id) => (
                <Badge key={id} label={PROVIDERS[id].nameAr} tone="neutral" />
              ))}
            </View>
          </Accordion>

          <Accordion
            title="حالة النظام والقدرات"
            subtitle="تُقرأ مباشرة من الخادم — كما هي فعليًا"
            icon="server-outline"
          >
            <SystemStatusCard />
          </Accordion>

          <Accordion
            title="التكاملات والموصلات"
            subtitle="GitHub · الفوترة · مخزن المتجهات · تتبّع الأخطاء · المتصفح"
            icon="git-network-outline"
          >
            <IntegrationsCard />
          </Accordion>
        </View>

        {/* About */}
        <SectionHeader title="حول التطبيق" icon="information-circle-outline" style={{ marginTop: theme.spacing.xl }} />
        <Card padded={false}>
          <ListRow title="الإصدار" icon="pricetag-outline" right={<Text variant="label" weight="semibold">2.0.0</Text>} />
          <Divider spacing={0} style={{ marginHorizontal: theme.spacing.lg }} />
          <ListRow title="المنصة" icon="layers-outline" right={<Text variant="label" weight="semibold">Expo / React Native</Text>} />
          <Divider spacing={0} style={{ marginHorizontal: theme.spacing.lg }} />
          <ListRow
            title="إعادة ضبط الإعدادات"
            subtitle="استرجاع القيم الافتراضية"
            icon="refresh-outline"
            iconColor={theme.colors.danger}
            onPress={() => void reset()}
            showChevron
          />
        </Card>

        <SectionHeader title="المستندات القانونية" icon="document-text-outline" style={{ marginTop: theme.spacing.xl }} />
        <Card padded={false}>
          <ListRow title="سياسة الخصوصية" subtitle="مسودة تتطلب مراجعة قانونية" icon="shield-checkmark-outline" showChevron onPress={() => router.push('/privacy')} />
          <Divider spacing={0} style={{ marginHorizontal: theme.spacing.lg }} />
          <ListRow title="شروط الاستخدام" subtitle="مسودة تتطلب مراجعة قانونية" icon="document-text-outline" showChevron onPress={() => router.push('/terms')} />
        </Card>

        <Text variant="caption" tone="subtle" align="center" style={{ marginTop: theme.spacing.xl }}>
          Ai-Semo0o-Agent · منصة ذكاء اصطناعي متكاملة
        </Text>
      </ScrollView>

      <Sheet
        visible={modelPicker}
        onClose={() => setModelPicker(false)}
        title="اختر النموذج"
        subtitle="النماذج المتاحة عبر المزوّدين المفعّلين"
        maxHeight="82%"
      >
        {PROVIDER_IDS.map((pid) => {
          const models = modelsByProvider(pid);
          if (models.length === 0) return null;
          const provider = PROVIDERS[pid];
          return (
            <View key={pid} style={{ marginBottom: theme.spacing.lg }}>
              <View style={styles.provHeader}>
                <View style={[styles.dot, { backgroundColor: provider.accent }]} />
                <Text variant="label" weight="semibold">
                  {provider.nameAr}
                </Text>
              </View>
              {models.map((m) => {
                const active = settings.activeModel === m.id;
                return (
                  <Pressable
                    key={m.id}
                    onPress={() => {
                      update({ activeModel: m.id });
                      setModelPicker(false);
                    }}
                    style={[
                      styles.modelRow,
                      {
                        borderColor: active ? theme.colors.primary : theme.colors.border,
                        backgroundColor: active ? theme.colors.primarySoft : theme.colors.surface,
                        borderRadius: theme.radius.lg,
                      },
                    ]}
                  >
                    <View style={{ flex: 1 }}>
                      <Text variant="label" weight="semibold">
                        {m.name}
                      </Text>
                      <Text variant="caption" tone="muted" numberOfLines={1}>
                        {m.description}
                      </Text>
                    </View>
                    {active ? <Icon name="checkmark-circle" size={20} tone="primary" /> : null}
                  </Pressable>
                );
              })}
            </View>
          );
        })}
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  chipRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  switchLabel: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  provHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  modelRow: { flexDirection: 'row', alignItems: 'center', padding: 14, marginBottom: 8, borderWidth: 1 },
});
