import React from 'react';
import {
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  View,
} from 'react-native';
import { useTheme, useThemeController } from '../theme';
import type { ThemePreference } from '../theme';
import { AppHeader } from '../components/composite/AppHeader';
import { SectionHeader } from '../components/composite/SectionHeader';
import { ListRow } from '../components/composite/ListRow';
import { Card } from '../components/ui/Card';
import { Text } from '../components/ui/Text';
import { Button } from '../components/ui/Button';
import { Chip } from '../components/ui/Chip';
import { Badge } from '../components/ui/Badge';
import { Input } from '../components/ui/Input';
import { Divider } from '../components/ui/Divider';
import { Icon } from '../components/ui/Icon';
import { Avatar } from '../components/ui/Avatar';
import { useAppStore } from '../store/useAppStore';
import { PROVIDERS, getModel, modelsByProvider } from '../data/models';
import { ProviderId } from '../types/model';

const THEME_OPTIONS: { label: string; value: ThemePreference; icon: 'moon-outline' | 'sunny-outline' | 'contrast-outline' }[] = [
  { label: 'داكن', value: 'dark', icon: 'moon-outline' },
  { label: 'فاتح', value: 'light', icon: 'sunny-outline' },
  { label: 'النظام', value: 'system', icon: 'contrast-outline' },
];

const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function Settings() {
  const theme = useTheme();
  const controller = useThemeController();
  const settings = useAppStore((s) => s.settings);
  const update = useAppStore((s) => s.update);
  const setApiKey = useAppStore((s) => s.setApiKey);
  const reset = useAppStore((s) => s.reset);

  const [modelPicker, setModelPicker] = React.useState(false);
  const [keyDrafts, setKeyDrafts] = React.useState<Partial<Record<ProviderId, string>>>({});

  const activeModel = getModel(settings.activeModel);
  const activeProvider = activeModel ? PROVIDERS[activeModel.provider] : undefined;

  const commitKey = (provider: ProviderId) => {
    const value = keyDrafts[provider] ?? '';
    setApiKey(provider, value);
    setKeyDrafts((prev) => ({ ...prev, [provider]: '' }));
  };

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
              onValueChange={(v) => controller.setPreference(v ? 'dark' : 'light')}
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

        {/* API keys */}
        <SectionHeader
          title="مفاتيح API"
          subtitle="تُحفظ محليًا على جهازك فقط"
          icon="key-outline"
          style={{ marginTop: theme.spacing.xl }}
        />
        {PROVIDER_IDS.map((id) => {
          const provider = PROVIDERS[id];
          const saved = settings.apiKeys[id];
          return (
            <Card key={id} style={{ marginBottom: theme.spacing.sm }}>
              <View style={styles.providerHead}>
                <Avatar name={provider.name} emoji="🔑" size={38} color={provider.accent} />
                <View style={{ flex: 1, marginStart: theme.spacing.md }}>
                  <Text variant="label" weight="semibold">
                    {provider.nameAr}
                  </Text>
                  <Text variant="caption" tone="muted">
                    {provider.descriptionAr}
                  </Text>
                </View>
                {saved ? <Badge label="مُفعّل" tone="success" /> : <Badge label="غير متصل" tone="neutral" />}
              </View>
              {provider.requiresApiKey ? (
                <View style={{ marginTop: theme.spacing.md }}>
                  <Input
                    placeholder={saved ? '••••••••••••' : 'الصق مفتاح API هنا'}
                    icon="lock-closed-outline"
                    secureTextEntry
                    autoCapitalize="none"
                    value={keyDrafts[id] ?? ''}
                    onChangeText={(t) => setKeyDrafts((prev) => ({ ...prev, [id]: t }))}
                  />
                  <View style={styles.keyActions}>
                    <Button
                      label="حفظ"
                      size="sm"
                      icon="checkmark-outline"
                      onPress={() => commitKey(id)}
                      disabled={!(keyDrafts[id] ?? '').trim()}
                    />
                    <Button
                      label="التوثيق"
                      size="sm"
                      variant="ghost"
                      icon="open-outline"
                      onPress={() => {
                        if (provider.docsUrl) void Linking.openURL(provider.docsUrl);
                      }}
                    />
                  </View>
                </View>
              ) : (
                <Text variant="caption" tone="muted" style={{ marginTop: theme.spacing.sm }}>
                  لا يتطلب هذا المزوّد مفتاحًا — يعمل محليًا.
                </Text>
              )}
            </Card>
          );
        })}

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

        <Text variant="caption" tone="subtle" align="center" style={{ marginTop: theme.spacing.xl }}>
          Ai-Semo0o-Agent · منصة ذكاء اصطناعي متكاملة
        </Text>
      </ScrollView>

      {/* Model picker */}
      <Modal visible={modelPicker} transparent animationType="slide" onRequestClose={() => setModelPicker(false)}>
        <Pressable style={styles.backdrop} onPress={() => setModelPicker(false)}>
          <Pressable
            style={[
              styles.sheet,
              { backgroundColor: theme.colors.surfaceElevated, borderTopLeftRadius: theme.radius['2xl'], borderTopRightRadius: theme.radius['2xl'] },
            ]}
            onPress={() => {}}
          >
            <View style={styles.sheetHead}>
              <Text variant="subtitle" weight="bold">
                اختر النموذج
              </Text>
              <Pressable onPress={() => setModelPicker(false)} hitSlop={10}>
                <Icon name="close" size={22} tone="muted" />
              </Pressable>
            </View>
            <ScrollView style={{ maxHeight: 460 }} showsVerticalScrollIndicator={false}>
              {PROVIDER_IDS.map((pid) => {
                const models = modelsByProvider(pid);
                if (models.length === 0) return null;
                const provider = PROVIDERS[pid];
                return (
                  <View key={pid} style={{ marginBottom: theme.spacing.lg }}>
                    <Text variant="label" tone="muted" style={{ marginBottom: theme.spacing.sm }}>
                      {provider.nameAr}
                    </Text>
                    {models.map((m) => (
                      <Pressable
                        key={m.id}
                        onPress={() => {
                          update({ activeModel: m.id });
                          setModelPicker(false);
                        }}
                        style={[
                          styles.modelRow,
                          {
                            backgroundColor:
                              settings.activeModel === m.id ? theme.colors.primarySoft : theme.colors.surfaceMuted,
                            borderRadius: theme.radius.lg,
                            marginBottom: 8,
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
                        {settings.activeModel === m.id ? (
                          <Icon name="checkmark-circle" size={20} tone="primary" />
                        ) : null}
                      </Pressable>
                    ))}
                  </View>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  chipRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  switchLabel: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  providerHead: { flexDirection: 'row', alignItems: 'center' },
  keyActions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { padding: 20, maxHeight: '82%' },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  modelRow: { flexDirection: 'row', alignItems: 'center', padding: 14 },
});
